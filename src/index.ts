import chalk from "chalk";
import { input } from "@inquirer/prompts";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { OpenRouter } from "@openrouter/sdk";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";

marked.use(markedTerminal() as never);

const client = new OpenRouter();
const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-luna";
const systemPrompt = "Read a file before changing it. Run the check after every change and read its output. Fix a failing check before doing anything else. Only say a job is done when a command you ran confirms it.";
const messages: any[] = [{ role: "system", content: systemPrompt }];
const root = process.cwd();
const tools: any[] = [{
  type: "function" as const,
  function: {
    name: "read_file",
    description: "Read a file in this project.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
}];

tools.push({
  type: "function" as const,
  function: {
    name: "edit_file",
    description: "Replace text in a file in this project.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
});

tools.push({
  type: "function",
  function: {
    name: "bash",
    description: "Run a bash command from the project root.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
});

function projectFile(path: string) {
  if (isAbsolute(path) || !resolve(root, path).startsWith(`${root}/`)) return;
  return resolve(root, path);
}

async function readProjectFile(path: string) {
  const file = projectFile(path);
  if (!file) return "Error: path must be inside this project.";

  try {
    return await readFile(file, "utf8");
  } catch (error) {
    return `Error: ${(error as Error).message}`;
  }
}

async function editProjectFile(path: string, oldText: string, newText: string) {
  const file = projectFile(path);
  if (!file) return "Error: path must be inside this project.";

  try {
    const text = await readFile(file, "utf8");
    const matches = text.split(oldText).length - 1;
    if (matches !== 1) return `Error: old_text was found ${matches} times.`;
    await writeFile(file, text.replace(oldText, newText));
    return "Edit complete.";
  } catch (error) {
    return `Error: ${(error as Error).message}`;
  }
}

function runBash(command: string) {
  return new Promise<string>(resolveResult => {
    const child = spawn("bash", ["-c", command], { cwd: root });
    let output = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);

    child.stdout.on("data", data => output += data);
    child.stderr.on("data", data => output += data);
    child.on("error", error => {
      clearTimeout(timeout);
      resolveResult(`Error: ${error.message}\nExit code: unavailable`);
    });
    child.on("close", code => {
      clearTimeout(timeout);
      const text = output.length > 8_000
        ? `${output.slice(0, 8_000)}\nOutput truncated after 8000 characters.`
        : output;
      const status = timedOut ? "Command timed out after 30 seconds." : "";
      resolveResult(`${text}\n${status}\nExit code: ${code ?? "unavailable"}`.trim());
    });
  });
}

async function runTool(name: string, args: any) {
  if (name === "read_file") return readProjectFile(args.path);
  if (name === "edit_file") return editProjectFile(args.path, args.old_text, args.new_text);
  if (name === "bash") return runBash(args.command);
  return `Error: unknown tool ${name}.`;
}

async function ask() {
  await appendFile("agent.log", `${new Date().toISOString()} [llm] request: ${messages.length} messages, tools: ${tools.map(tool => tool.function.name).join(", ")}\n`);
  const response = await client.chat.send({ chatRequest: { model, messages, tools, stream: false } });
  if (!("choices" in response)) throw new Error("Expected a complete response");

  const assistant = response.choices[0].message;
  const calls = assistant.toolCalls;
  const text = typeof assistant.content === "string" ? assistant.content : "";
  const detail = calls?.length
    ? `tool_calls: ${calls.map(call => `${call.function.name}(${call.function.arguments})`).join(", ")}`
    : text ? `assistant text: ${text.length} chars` : "empty";
  await appendFile("agent.log", `${new Date().toISOString()} [llm] response: ${detail}\n`);
  return assistant;
}
try {
  while (true) {
    const prompt = await input({ message: chalk.cyan("You:") });
    messages.push({ role: "user", content: prompt });
    let assistant = await ask();
    let rounds = 0;

    while (assistant.toolCalls?.length) {
      if (rounds === 5) {
        console.log("Assistant reached the 5 tool-round limit.");
        break;
      }

      messages.push(assistant);
      for (const call of assistant.toolCalls) {
        const args = JSON.parse(call.function.arguments);
        const detail = args.path ?? args.command;
        console.log(chalk.yellow(`Using: ${call.function.name}(${detail})`));
        const result = await runTool(call.function.name, args);
        await appendFile("agent.log", `${new Date().toISOString()} [tool] ${call.function.name}(${detail}): ${result.length} chars\n`);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: result,
        });
      }
      assistant = await ask();
      rounds += 1;
    }

    if (assistant.toolCalls?.length) continue;

    const content = assistant.content;
    const reply = typeof content === "string" ? content : "";
    if (!reply) console.log("Assistant did not return a final answer.");
    else messages.push({ role: "assistant", content: reply });

    if (reply) {
      console.log(chalk.green("Assistant:"));
      console.log(marked.parse(reply));
      console.log(chalk.dim("─".repeat(40)));
    }
  }
} catch (error: any) {
  if (error.name !== "ExitPromptError") throw error;
}
