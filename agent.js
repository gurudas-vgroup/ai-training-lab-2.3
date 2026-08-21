import "dotenv/config";
import * as readline from "node:readline/promises";
import { z } from "zod";
import { createSdkMcpServer, tool, query } from "@anthropic-ai/claude-agent-sdk";

// Fail fast: the Claude Agent SDK subprocess needs this to authenticate.
if (!process.env["ANTHROPIC_API_KEY"]) {
  throw new Error("ANTHROPIC_API_KEY is not set. Add it to your .env file.");
}

// Deterministic mock stock levels, keyed by SKU. Unknown SKUs fall back to a
// stable pseudo-random count derived from the SKU string so repeat calls agree.
const MOCK_STOCK = {
  "WB-1L": 42,
};

// Simple string hash -> stable "random" stock count for any SKU not in
// MOCK_STOCK, so the same unknown SKU always reports the same number.
function getMockStockCount(sku) {
  const known = MOCK_STOCK[sku];
  if (known !== undefined) {
    return known;
  }
  let hash = 0;
  for (const char of sku) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000;
  }
  return hash;
}

// The one custom tool this agent exposes to Claude. `tool()` wires together
// the name, description, zod input schema, and the async handler that runs
// when Claude actually calls it.
const getStockLevelTool = tool(
  "get_stock_level",
  "Look up the current stock count for a given SKU.",
  { sku: z.string().describe("The SKU to look up, e.g. WB-1L") },
  async ({ sku }) => {
    const count = getMockStockCount(sku);
    const resultText = `SKU ${sku}: ${count} in stock`;
    console.log(`[tool result] ${resultText}`);
    // CallToolResult shape expected by the SDK: an array of content blocks.
    return {
      content: [{ type: "text", text: resultText }],
    };
  },
);

// Bundles the tool(s) above into an in-process MCP server the SDK can call
// directly, without spawning a separate MCP process.
const inventoryTools = createSdkMcpServer({
  name: "inventory-tools",
  version: "1.0.0",
  tools: [getStockLevelTool],
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Ask a human at the terminal to approve/deny every tool call before it runs,
// rather than letting the SDK auto-decide or silently deny it. This is the
// `canUseTool` callback wired into query() below — the SDK calls it right
// before executing any tool, and awaits its verdict before proceeding.
const requireHumanApproval = async (toolName, input, opts) => {
  console.log(`\n[permission request] Tool "${toolName}" wants to run with input:`);
  console.log(JSON.stringify(input, null, 2));
  const answer = await rl.question(`Allow "${toolName}"? (y/n) `);
  if (answer.trim().toLowerCase().startsWith("y")) {
    // "allow" can also rewrite the input via updatedInput; here we pass it
    // through unchanged since we're only gating, not editing, the call.
    return { behavior: "allow", updatedInput: input, toolUseID: opts.toolUseID };
  }
  // "deny" stops the tool from running; `message` is surfaced back to Claude
  // as the reason, so it can explain the refusal instead of retrying blindly.
  return { behavior: "deny", message: "Denied by user at the terminal prompt.", toolUseID: opts.toolUseID };
};

// "default" mode prompts for every tool call instead of auto-approving or
// auto-denying it; paired with canUseTool below, that prompt is a real
// terminal approval step rather than an implicit decision.
const permissionMode = "default";

async function main() {
  // Single, fixed prompt — this lab demonstrates the approval flow on one
  // query() call rather than running an interactive multi-turn REPL.
  const prompt = "How many of SKU WB-1L do we have in stock?";

  const stream = query({
    prompt,
    options: {
      permissionMode,
      canUseTool: requireHumanApproval,
      mcpServers: {
        "inventory-tools": inventoryTools,
      },
    },
  });

  // query() yields one SDKMessage at a time for the run: "assistant" messages
  // as Claude thinks/replies, "user" messages when a tool_result is fed back
  // in, and a final "result" message once the run completes.
  for await (const message of stream) {
    if (message.type === "assistant") {
      // An assistant message's content is a list of blocks — usually a mix
      // of plain text and tool_use requests within the same turn.
      for (const block of message.message.content) {
        if (block.type === "text") {
          console.log(`\n[assistant] ${block.text}`);
        } else if (block.type === "tool_use") {
          console.log(`\n[tool call] ${block.name}(${JSON.stringify(block.input)})`);
        }
      }
    } else if (message.type === "user") {
      // Tool results are echoed back into the transcript as "user" messages
      // (the Anthropic API requires tool_result blocks to carry role "user").
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result") {
            const text =
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content);
            console.log(`[tool_result echoed to model] ${text}`);
          }
        }
      }
    } else if (message.type === "result") {
      // Marks the run as complete; success carries the final answer text,
      // any other subtype means it stopped early (error, max turns, etc.).
      if (message.subtype === "success") {
        console.log(`\n[final result] ${message.result}`);
      } else {
        console.log(`\n[final result: error] subtype=${message.subtype}`);
      }
    }
  }

  rl.close();
}

main().catch((error) => {
  rl.close();
  console.error(error);
  process.exitCode = 1;
});
