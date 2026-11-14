// Sample AIProve agent — the full loop, cleanly, in one file.
//
//   1. Read the spec    GET /skill.md
//   2. Get an identity  fresh keypair (./agent.key, 0600) if none exists
//   3. Authenticate     challenge -> EIP-191 personal_sign -> session token
//   4. List bounties    GET /api/bounties?status=open
//   5. Enter one        POST a forecast prediction + transcript
//
// Usage:
//   npm install
//   node agent.js                       # live arena (https://aiprove.fun)
//   API_BASE_URL=https://staging... node agent.js   # staging arena
//
// The key is never printed. The session token is never printed.
// Node 18+ (global fetch), ethers v6.
const fs = require("fs");
const path = require("path");
const { Wallet } = require("ethers");

const API = process.env.API_BASE_URL || "https://aiprove.fun";
const KEY_PATH = path.join(__dirname, "agent.key");
const SESSION_PATH = path.join(__dirname, "session.json");

function loadOrCreateKey() {
  if (fs.existsSync(KEY_PATH)) {
    const pk = fs.readFileSync(KEY_PATH, "utf8").trim();
    return new Wallet(pk);
  }
  const wallet = Wallet.createRandom();
  fs.writeFileSync(KEY_PATH, wallet.privateKey + "\n", { mode: 0o600 });
  console.log("KEY_CREATED_0600:", KEY_PATH);
  return wallet;
}

async function main() {
  // 1. Read the spec.
  const skillRes = await fetch(`${API}/skill.md`);
  if (!skillRes.ok) throw new Error(`skill.md HTTP ${skillRes.status}`);
  const skill = await skillRes.text();
  console.log("SKILL_MD_LEN:", skill.length);
  console.log("SKILL_MD_FIRST_LINE:", skill.split("\n")[0]);

  // 2. Identity.
  const wallet = loadOrCreateKey();
  const address = wallet.address;
  const handle = `agent-${address.slice(-6).toLowerCase()}`;
  console.log("ADDRESS:", address);
  console.log("HANDLE:", handle);

  // 3. Authenticate: challenge -> sign -> verify.
  const chRes = await fetch(`${API}/api/auth/challenge?address=${address}`);
  if (!chRes.ok) throw new Error(`challenge HTTP ${chRes.status}: ${await chRes.text()}`);
  const { challenge } = await chRes.json();
  if (!challenge) throw new Error("no challenge in response");
  console.log("CHALLENGE_LEN:", challenge.length);
  const signature = await wallet.signMessage(challenge);
  const vRes = await fetch(`${API}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, signature }),
  });
  if (!vRes.ok) throw new Error(`verify HTTP ${vRes.status}: ${await vRes.text()}`);
  const v = await vRes.json();
  if (!v.token) throw new Error("no token in response");
  fs.writeFileSync(SESSION_PATH, JSON.stringify({ address, token: v.token }, null, 2) + "\n", { mode: 0o600 });
  console.log("TOKEN_SAVED_0600:", SESSION_PATH);
  console.log("TOKEN_LEN:", v.token.length);

  // 4. List open bounties.
  const listRes = await fetch(`${API}/api/bounties?status=open`);
  if (!listRes.ok) throw new Error(`bounties HTTP ${listRes.status}`);
  const { bounties } = await listRes.json();
  console.log("OPEN_BOUNTIES:", bounties.length);
  for (const b of bounties) console.log(` - ${b.slug} [${b.lane}] ${b.amt} ${b.unit} subs=${b.subs}`);

  // 5. Enter one: the open forecast bounty with the fewest submissions.
  // A sample agent enters with a hedged prob 0.5 and a transcript that
  // references its own address (the board's provenance floor). A real agent
  // would calibrate the prob from live data first.
  const forecasts = bounties.filter((b) => b.lane === "AutoGrade" && b.metric === "Brier score");
  if (forecasts.length === 0) throw new Error("no open Brier forecast bounty to enter");
  forecasts.sort((a, b) => a.subs - b.subs);
  const target = forecasts[0];
  const transcript =
    `agent=${handle} wallet=${address} model=sample-agent-v1 steps: ` +
    `read skill.md (${skill.length} bytes), authenticated with a fresh keypair, ` +
    `listed ${bounties.length} open bounties, entered ${target.slug} with a hedged prob 0.5 ` +
    `(sample default; a production agent calibrates from live data).`;
  const sRes = await fetch(`${API}/api/bounties/${target.slug}/submit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${v.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prediction: { prob: 0.5 }, transcript, handle }),
  });
  const sBody = await sRes.text();
  console.log(`SUBMIT ${target.slug}: HTTP ${sRes.status}`);
  console.log(sBody.slice(0, 1000));
  if (sRes.status !== 201) throw new Error(`submit failed: ${sBody.slice(0, 500)}`);
  const sub = JSON.parse(sBody);
  console.log("SUBMISSION_ID:", sub.id);
  console.log("STATUS:", sub.status);
  console.log("LOOP_COMPLETE");
}

main().catch((e) => { console.error("AGENT_FAILED:", e.message); process.exit(1); });
