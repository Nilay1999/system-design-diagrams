/**
 * A deliberately tiny highlighter for the YAML manifests and shell commands in the docs. It only marks
 * comments, keys, strings, commands and flags; anything it doesn't understand stays plain text.
 */

export type TokenKind = "comment" | "key" | "string" | "command" | "flag";

export interface Token {
  text: string;
  kind?: TokenKind;
}

const YAML = new Set(["yaml", "yml"]);
const SHELL = new Set(["bash", "sh", "shell", "console", "zsh"]);

/** Start of a `#` comment: at the line start or after whitespace, and not inside quotes. */
function commentStart(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return i;
    }
  }
  return -1;
}

const YAML_CODE = /("[^"]*"|'[^']*')|([A-Za-z_][\w.\-/]*)(?=:(?:\s|$))/g;
const SHELL_CODE = /("[^"]*"|'[^']*')|(?<=^|\s)(--?[A-Za-z][\w-]*)/g;
const SHELL_COMMAND = /^(\s*)(kubectl|k|helm|kind|eksctl|aws|docker|crictl|etcdctl|git|curl|nslookup|nc|iptables|alias|export|source|cat|watch)(?=\s|$)/;

function tokenizeCode(code: string, pattern: RegExp, keyKind: TokenKind): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of code.matchAll(pattern)) {
    if (m.index > last) out.push({ text: code.slice(last, m.index) });
    out.push({ text: m[0], kind: m[1] ? "string" : keyKind });
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push({ text: code.slice(last) });
  return out;
}

function tokenizeLine(line: string, lang: "yaml" | "shell"): Token[] {
  const hash = commentStart(line);
  let code = hash === -1 ? line : line.slice(0, hash);
  const out: Token[] = [];
  if (lang === "shell") {
    const cmd = SHELL_COMMAND.exec(code);
    if (cmd) {
      if (cmd[1]) out.push({ text: cmd[1] });
      out.push({ text: cmd[2], kind: "command" });
      code = code.slice(cmd[0].length);
    }
    out.push(...tokenizeCode(code, SHELL_CODE, "flag"));
  } else {
    out.push(...tokenizeCode(code, YAML_CODE, "key"));
  }
  if (hash !== -1) out.push({ text: line.slice(hash), kind: "comment" });
  return out;
}

/** Tokens for a code block, with newlines kept as plain text. Unknown languages come back as one token. */
export function highlight(code: string, lang: string | undefined): Token[] {
  const mode = lang && YAML.has(lang) ? "yaml" : lang && SHELL.has(lang) ? "shell" : undefined;
  if (!mode) return [{ text: code }];
  return code.split("\n").flatMap((line, i) => [...(i ? [{ text: "\n" }] : []), ...tokenizeLine(line, mode)]);
}
