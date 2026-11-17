#!/usr/bin/env node
// A scripted stand-in for `claude-agent-acp`, speaking the frames recorded in
// testdata/autopilot-frames/claude-0.91.0-plan-question-exit.ndjson, so the whole loop can be run with no
// model and no credits. FAKE_ACP_SCENARIO names a JSON file with one entry per session, in the order the
// loop opens them; FAKE_ACP_STATE is a directory where it counts sessions and records what it was sent.
//
// A session entry may hold:
//   question: { header, question, options: [label, ...] }   asked in plan mode through elicitation/create
//   plan: text                                              the plan shown to the permission request
//   work: shell text                                        run in the repository when the session works
//   silentFirstTurn: text                                   first working turn ends with this message and no work
//   rateLimit: { resetsInSeconds, type }                    first working turn ends on a rejected usage limit
//   hold: true                                              the working turn never ends, so a test can kill the loop mid-session
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const state = process.env.FAKE_ACP_STATE;
const scenario = JSON.parse(readFileSync(process.env.FAKE_ACP_SCENARIO, "utf8")).sessions;
const countFile = `${state}/count`;
const n = (existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0) + 1;
writeFileSync(countFile, String(n));
const me = scenario[Math.min(n, scenario.length) - 1] ?? {};
const sessionId = `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const log = (name, text) => appendFileSync(`${state}/${name}`, `${text}\n`);

let mode = "auto";
let asked = false;
let silenced = false;
let limited = false;
let nextRequestId = 100;
const waiting = new Map();
let cwd = process.cwd();

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (body) => send({ method: "session/update", params: { sessionId, update: body } });
const setMode = (id) => {
  mode = id;
  update({ sessionUpdate: "current_mode_update", currentModeId: id });
};
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextRequestId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const INIT = {
  protocolVersion: 1,
  agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true }, loadSession: true },
  agentInfo: { name: "@agentclientprotocol/claude-agent-acp", title: "Claude Agent", version: "0.91.0" },
  authMethods: [],
};
const MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"].map((id) => ({ id, name: id }));

function elicitation(q) {
  const oneOf = q.options.map((label) => ({ const: label, title: label }));
  return {
    mode: "form",
    sessionId,
    toolCallId: "toolu_fake_question",
    message: q.question,
    requestedSchema: {
      type: "object",
      properties: { question_0: { type: "string", title: q.header, oneOf }, question_0_custom: { type: "string", title: "Other" } },
    },
  };
}

function exitPlanRequest() {
  const plan = me.plan ?? "Do the task.";
  return {
    toolCall: {
      toolCallId: "toolu_fake_exit",
      name: "ExitPlanMode",
      status: "pending",
      rawInput: { plan },
      title: "Approve Plan",
      kind: "switch_mode",
      content: [{ type: "content", content: { type: "text", text: plan } }],
    },
    options: [
      { optionId: "exit-plan-bypass", name: "Yes, and bypass permissions", kind: "allow_always" },
      { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
    ],
    sessionId,
  };
}

function work() {
  if (me.work) execSync(me.work, { cwd, stdio: "inherit" });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
}

function rateLimitFrame() {
  const info = { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + (me.rateLimit.resetsInSeconds ?? 3600), rateLimitType: me.rateLimit.type ?? "five_hour" };
  update({ sessionUpdate: "usage_update", used: 1, size: 1000000, _meta: { "_claude/rateLimit": info } });
}

async function planTurn() {
  if (me.question && !asked) {
    asked = true;
    const answer = await ask("elicitation/create", elicitation(me.question));
    log("answers.log", JSON.stringify(answer.content));
  }
  const choice = await ask("session/request_permission", exitPlanRequest());
  if (choice.outcome?.optionId !== "exit-plan-bypass") return "cancelled";
  setMode("bypassPermissions");
  return workTurn();
}

function workTurn() {
  if (me.hold) return new Promise(() => {});
  if (me.rateLimit && !limited) {
    limited = true;
    rateLimitFrame();
    return "end_turn";
  }
  if (me.silentFirstTurn && !silenced) {
    silenced = true;
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: me.silentFirstTurn } });
    return "end_turn";
  }
  work();
  return "end_turn";
}

async function onRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") return send({ id, result: INIT });
  if (method === "session/new") {
    cwd = params.cwd ?? cwd;
    return send({ id, result: { sessionId, modes: { currentModeId: "auto", availableModes: MODES }, configOptions: [] } });
  }
  if (method === "session/set_config_option") {
    if (params.configId === "mode") setMode(params.value);
    return send({ id, result: { configOptions: [] } });
  }
  if (method === "session/prompt") {
    log(`prompts-${n}.log`, params.prompt.map((block) => block.text ?? block.resource?.text ?? "").join("\n---\n"));
    const stopReason = mode === "plan" ? await planTurn() : await workTurn();
    return send({ id, result: { stopReason, usage: {} } });
  }
  return send({ id, error: { code: -32601, message: `fake agent: no method ${method}` } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined && waiting.has(message.id)) {
    waiting.get(message.id)(message.result);
    waiting.delete(message.id);
    return;
  }
  if (message.id !== undefined) void onRequest(message);
});
