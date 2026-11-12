#!/usr/bin/env node
/**
 * FontManager MCP server（stdio）
 *
 * 作用：把 FontManager 的本地 API 包装成 MCP 工具，让 Agent（WorkBuddy / Claude / Cursor…）
 * 在对话里就能查字体、启停、建快照、评分。**它自己不做任何业务逻辑**，只是
 * 「拼 HTTP 请求 → 透传结果」，所以主程序不用背 MCP 依赖，升级也不影响它。
 *
 * 用法：先在 FontManager 设置 → 本地 API 打开开关，再在 MCP 客户端里登记本脚本：
 *   { "mcpServers": { "fontmanager": { "command": "node", "args": ["<此文件绝对路径>"] } } }
 *
 * 服务发现：读 %APPDATA%\FontManager\api.json（端口 + 令牌 + base）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "fontmanager", version: "1.0.0" };

function apiJsonPath() {
  const appData =
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "FontManager", "api.json");
}

function readApi() {
  const p = apiJsonPath();
  try {
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!doc.port || !doc.token) throw new Error("api.json 缺 port/token");
    return {
      base: doc.base || `http://127.0.0.1:${doc.port}/api/v1`,
      token: doc.token,
      port: doc.port,
    };
  } catch (e) {
    const hint = `读不到 ${p}：${e.message}。请打开 FontManager → 设置 → 本地 API，把开关打开后再试。`;
    throw new Error(hint);
  }
}

async function call(method, route, body) {
  const { base, token } = readApi();
  const res = await fetch(base + route, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      // 主程序 1.9.25 起：危险操作要「总开关 + 单独授权」两道闸，
      // MCP 靠这个头把自己和「本地 API 脚本」区分开。
      "x-zfm-client": "mcp",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

// ───────────────────────────── 工具定义 ─────────────────────────────

const TOOLS = [
  {
    name: "list_fonts",
    description:
      "查字体库里的字体。可按关键词（字族/样式/文件名）、字族名、版权分类筛选。返回字族、样式、是否启用、路径。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，模糊匹配字族/样式/文件名" },
        family: { type: "string", description: "字族名，精确匹配" },
        license: {
          type: "string",
          description: "版权分类：free / paid / timelimited / unknown",
        },
        limit: { type: "number", description: "最多返回几条，默认 50" },
      },
    },
  },
  {
    name: "list_families",
    description: "列出所有字族名（去重）。想知道准确名字时先用它。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "activate_fonts",
    description: "启用字体族（会写注册表，立刻在其它软件里可用）。只传字族名即可。",
    inputSchema: {
      type: "object",
      properties: {
        families: {
          type: "array",
          items: { type: "string" },
          description: "字族名列表",
        },
      },
      required: ["families"],
    },
  },
  {
    name: "deactivate_fonts",
    description: "停用字体族。系统字体改不动，会被跳过并在结果里说明。",
    inputSchema: {
      type: "object",
      properties: {
        families: { type: "array", items: { type: "string" } },
      },
      required: ["families"],
    },
  },
  {
    name: "list_snapshots",
    description: "列出快照（名字、创建时间、字体条目数）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "take_snapshot",
    description:
      "新建快照。不传 families 就收录当前已启用的字体；传了就只收这些字族。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        families: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
    },
  },
  {
    name: "apply_snapshot",
    description: "把某个快照应用到当前字体库（该启的启、该停的停）。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "rate_font",
    description: "给字族打 1~5 星（自动收进收藏），传 0 清除评分。",
    inputSchema: {
      type: "object",
      properties: {
        family: { type: "string" },
        stars: { type: "number" },
      },
      required: ["family", "stars"],
    },
  },
  {
    name: "fonts_by_license",
    description:
      "按版权分类列出字族，例如 expired/paid 筛查；常与 deactivate_fonts 组合做批量治理。",
    inputSchema: {
      type: "object",
      properties: { license: { type: "string" } },
      required: ["license"],
    },
  },
  {
    name: "api_health",
    description: "看 API 是否在线、版本、已加载多少字面。出问题时先调它。",
    inputSchema: { type: "object", properties: {} },
  },
];

async function runTool(name, args = {}) {
  switch (name) {
    case "list_fonts": {
      const q = new URLSearchParams();
      if (args.query) q.set("q", args.query);
      if (args.family) q.set("family", args.family);
      if (args.license) q.set("license", args.license);
      q.set("limit", String(args.limit ?? 50));
      return call("GET", `/fonts?${q}`);
    }
    case "list_families":
      return call("GET", "/fonts/families");
    case "activate_fonts":
      return call("POST", "/fonts/activate", { families: args.families ?? [] });
    case "deactivate_fonts":
      return call("POST", "/fonts/deactivate", { families: args.families ?? [] });
    case "list_snapshots":
      return call("GET", "/snapshots");
    case "take_snapshot":
      return call("POST", "/snapshots", {
        name: args.name,
        families: args.families ?? [],
      });
    case "apply_snapshot":
      return call("POST", `/snapshots/${encodeURIComponent(args.name)}/apply`, {});
    case "rate_font":
      return call("PUT", "/curation/rating", {
        family: args.family,
        stars: args.stars ?? 0,
      });
    case "fonts_by_license": {
      const q = new URLSearchParams({ license: args.license ?? "", limit: "2000" });
      const data = await call("GET", `/fonts?${q}`);
      const fams = [...new Set((data.faces ?? []).map((f) => f.family))];
      return { total: fams.length, families: fams };
    }
    case "api_health":
      return call("GET", "/health");
    default:
      throw new Error(`未知工具：${name}`);
  }
}

// ───────────────────────────── JSON-RPC ─────────────────────────────

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
  );
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  try {
    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
        return;
      case "notifications/initialized":
      case "initialized":
        return; // 通知不需要回应
      case "ping":
        reply(id, {});
        return;
      case "tools/list":
        reply(id, { tools: TOOLS });
        return;
      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments ?? {};
        try {
          const data = await runTool(name, args);
          reply(id, {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            isError: false,
          });
        } catch (e) {
          // 工具内部错误按 MCP 约定放在 content 里，让 Agent 能读给用户听
          reply(id, {
            content: [{ type: "text", text: `出错了：${e.message}` }],
            isError: true,
          });
        }
        return;
      }
      default:
        if (id !== undefined) replyError(id, -32601, `不支持的方法：${method}`);
    }
  } catch (e) {
    if (id !== undefined) replyError(id, -32603, e.message);
  }
});

process.stderr.write(`[fontmanager-mcp] ready, api.json = ${apiJsonPath()}\n`);
