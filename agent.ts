import "dotenv/config";
import * as readline from "node:readline/promises";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  query,
  type PermissionMode,
  type PermissionResult,
  type CanUseTool,
} from "@anthropic-ai/claude-agent-sdk";

if (!process.env["ANTHROPIC_API_KEY"]) {
  throw new Error("ANTHROPIC_API_KEY is not set. Add it to your .env file.");
}

// Deterministic mock stock levels, keyed by SKU. Unknown SKUs fall back to a
// stable pseudo-random count derived from the SKU string so repeat calls agree.
const MOCK_STOCK: Readonly<Record<string, number>> = {
  "WB-1L": 42,
};

function getMockStockCount(sku: string): number {
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

const getStockLevelTool = tool(
  "get_stock_level",
  "Look up the current stock count for a given SKU.",
  { sku: z.string().describe("The SKU to look up, e.g. WB-1L") },
  async ({ sku }) => {
    const count = getMockStockCount(sku);
    const resultText = `SKU ${sku}: ${count} in stock`;
    console.log(`[tool result] ${resultText}`);
    return {
      content: [{ type: "text", text: resultText }],
    };
  },
);

const inventoryTools = createSdkMcpServer({
  name: "inventory-tools",
  version: "1.0.0",
  tools: [getStockLevelTool],
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Ask a human at the terminal to approve/deny every tool call before it runs,
// rather than letting the SDK auto-decide or silently deny it.
const requireHumanApproval: CanUseTool = async (toolName, input, opts): Promise<PermissionResult> => {
  console.log(`\n[permission request] Tool "${toolName}" wants to run with input:`);
  console.log(JSON.stringify(input, null, 2));
  const answer = await rl.question(`Allow "${toolName}"? (y/n) `);
  if (answer.trim().toLowerCase().startsWith("y")) {
    return { behavior: "allow", updatedInput: input, toolUseID: opts.toolUseID };
  }
  return { behavior: "deny", message: "Denied by user at the terminal prompt.", toolUseID: opts.toolUseID };
};

// "default" mode prompts for every tool call instead of auto-approving or
// auto-denying it; paired with canUseTool below, that prompt is a real
// terminal approval step rather than an implicit decision.
const permissionMode: PermissionMode = "default";

async function main(): Promise<void> {
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

  for await (const message of stream) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          console.log(`\n[assistant] ${block.text}`);
        } else if (block.type === "tool_use") {
          console.log(`\n[tool call] ${block.name}(${JSON.stringify(block.input)})`);
        }
      }
    } else if (message.type === "user") {
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
      if (message.subtype === "success") {
        console.log(`\n[final result] ${message.result}`);
      } else {
        console.log(`\n[final result: error] subtype=${message.subtype}`);
      }
    }
  }

  rl.close();
}

main().catch((error: unknown) => {
  rl.close();
  console.error(error);
  process.exitCode = 1;
});
