/**
 * Prompts for the dashboard password (no echo) and prints the value for
 * DASHBOARD_PASSWORD_HASH: an argon2id hash, base64-encoded so dotenv doesn't expand its `$`s.
 *
 *   npm run hash-password
 */
import { hash } from "@node-rs/argon2";

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error("Run this in an interactive terminal."));
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (ch: string) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        stdout.write("\n");
        resolve(value);
      } else if (ch === "\u0003") {
        stdin.setRawMode(false);
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const pw = await promptHidden("Dashboard password: ");
  if (pw.length < 12) throw new Error("Use at least 12 characters.");
  const again = await promptHidden("Confirm password: ");
  if (pw !== again) throw new Error("Passwords do not match.");
  const phc = await hash(pw); // argon2id with library defaults
  console.log(`\nDASHBOARD_PASSWORD_HASH=${Buffer.from(phc, "utf8").toString("base64")}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
