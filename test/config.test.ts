// `dip config` and the credentials file: the API key kept apart from argv and the
// environment, the same mechanism as openka-cli's `ka config`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { run } from "../src/cli/run.js";
import { DipClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import { readSecretFrom } from "../src/cli/io.js";
import { CredentialStore, maskCredential, resolveCredentialsPath } from "../src/cli/credentials.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

const KEY = "R2bzBYW.Eo5eVK2pZ0sJ1LbT8uWxQyNa";

/** A CLI whose credentials file lives in a temporary directory, and whose secret prompt answers `secret`. */
function makeCli(options: { env?: Record<string, string | undefined>; secret?: string; credentials?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dip-config-"));
  const store = new CredentialStore(join(dir, "dip-bundestag", "credentials"));
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(() => jsonResponse({ numFound: 0, documents: [] }));
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: () => undefined,
      outBinary: () => undefined,
      ...(options.secret === undefined ? {} : { readSecret: async () => options.secret as string }),
    },
    createClient: (opts) => new DipClient({ ...opts, transport: mt.transport }),
    env: options.env ?? {},
    ...(options.credentials === false ? {} : { credentials: () => store }),
  };
  return { deps, out, err, mt, store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("config set stores the key from the prompt, mode 0600 in a 0700 directory, and shows it masked", async () => {
  const cli = makeCli({ secret: `${KEY}\n` });
  try {
    assert.equal(await run(["config", "set", "api-key"], cli.deps), 0);
    assert.equal(cli.store.get("api-key"), KEY);
    assert.equal(statSync(cli.store.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(cli.dir, "dip-bundestag")).mode & 0o777, 0o700);
    assert.match(cli.err.join("\n"), /Stored api-key \(R2bz…QyNa\) in /);
    assert.doesNotMatch(cli.err.join("\n") + cli.out.join("\n"), new RegExp(KEY.replace(".", "\\.")));

    cli.out.length = 0;
    assert.equal(await run(["config", "get", "api-key"], cli.deps), 0);
    assert.deepEqual(cli.out, ["R2bz…QyNa"]);
    cli.out.length = 0;
    assert.equal(await run(["config", "get", "api-key", "--reveal"], cli.deps), 0);
    assert.deepEqual(cli.out, [KEY]);
    cli.out.length = 0;
    assert.equal(await run(["config", "list"], cli.deps), 0);
    assert.deepEqual(cli.out, ["api-key  R2bz…QyNa"]);

    assert.equal(await run(["config", "unset", "api-key"], cli.deps), 0);
    assert.equal(cli.store.get("api-key"), undefined);
    assert.equal(await run(["config", "unset", "api-key"], cli.deps), 1);
    assert.equal(await run(["config", "get", "api-key"], cli.deps), 1);
  } finally {
    cli.cleanup();
  }
});

test("config set never takes the value from the command line, and never repeats it", async () => {
  const cli = makeCli({ secret: KEY });
  try {
    assert.equal(await run(["config", "set", "api-key", KEY], cli.deps), 2);
    assert.match(cli.err.join("\n"), /takes the name only/);
    assert.doesNotMatch(cli.err.join("\n"), new RegExp(KEY.replace(".", "\\.")));
    assert.equal(cli.store.get("api-key"), undefined);
    assert.equal(await run(["config", "set", "password"], cli.deps), 2, "an unknown name");
  } finally {
    cli.cleanup();
  }
});

test("config set refuses a blank value or one with whitespace inside, and stores nothing", async () => {
  for (const secret of ["", "   ", "two words"]) {
    const cli = makeCli({ secret });
    try {
      assert.equal(await run(["config", "set", "api-key"], cli.deps), 2, JSON.stringify(secret));
      assert.match(cli.err.join("\n"), /Nothing was stored/);
      assert.equal(cli.store.get("api-key"), undefined);
    } finally {
      cli.cleanup();
    }
  }
});

test("the stored key is sent when neither --api-key nor DIP_API_KEY gives one, and only then", async () => {
  const cli = makeCli({ secret: KEY });
  try {
    await run(["config", "set", "api-key"], cli.deps);
    assert.equal(await run(["vorgang", "list"], cli.deps), 0);
    assert.equal(cli.mt.last().headers?.["Authorization"], `ApiKey ${KEY}`);
    const fromEnv = makeCli({ env: { DIP_API_KEY: "ENVKEY12345" } });
    // The env var and the flag come first.
    const viaEnv = { ...fromEnv.deps, credentials: () => cli.store };
    assert.equal(await run(["vorgang", "list"], viaEnv), 0);
    assert.equal(fromEnv.mt.last().headers?.["Authorization"], "ApiKey ENVKEY12345");
    assert.equal(await run(["--api-key", "FLAGKEY1234", "vorgang", "list"], viaEnv), 0);
    assert.equal(fromEnv.mt.last().headers?.["Authorization"], "ApiKey FLAGKEY1234");
    fromEnv.cleanup();
  } finally {
    cli.cleanup();
  }
});

test("a credentials file others can read is refused, and only when it is needed", async () => {
  const cli = makeCli();
  try {
    cli.store.set("api-key", KEY);
    chmodSync(cli.store.path, 0o644);
    assert.equal(await run(["vorgang", "list"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /can be read by others \(mode 644\).*chmod 600/);
    // A key given another way does not read the file at all.
    assert.equal(await run(["--api-key", "FLAGKEY1234", "vorgang", "list"], cli.deps), 0);
  } finally {
    cli.cleanup();
  }
});

test("deps without a credentials store never read a credentials file", async () => {
  const cli = makeCli({ credentials: false, env: { XDG_CONFIG_HOME: "/nonexistent" } });
  try {
    assert.equal(await run(["vorgang", "list"], cli.deps), 0);
    assert.equal(cli.mt.last().headers?.["Authorization"], undefined);
    assert.equal(await run(["config", "list"], cli.deps), 1);
  } finally {
    cli.cleanup();
  }
});

test("the credentials file: where it is, what it refuses, and how it masks", () => {
  assert.equal(resolveCredentialsPath({ XDG_CONFIG_HOME: "/x" }), "/x/dip-bundestag/credentials");
  assert.equal(resolveCredentialsPath({ XDG_CONFIG_HOME: "relative", HOME: "/home/me" }), "/home/me/.config/dip-bundestag/credentials");
  assert.equal(maskCredential("short"), "****");
  const dir = mkdtempSync(join(tmpdir(), "dip-store-"));
  try {
    const path = join(dir, "credentials");
    writeFileSync(path, "{ not json", { mode: 0o600 });
    assert.throws(() => new CredentialStore(path).get("api-key"), /not valid JSON/);
    writeFileSync(path, JSON.stringify({ "api-key": 5 }), { mode: 0o600 });
    assert.throws(() => new CredentialStore(path).get("api-key"), /not an object of names and strings/);
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "credentials"), JSON.stringify({ "api-key": KEY }), { mode: 0o600 });
    symlinkSync(join(dir, "real", "credentials"), join(dir, "link"));
    assert.throws(() => new CredentialStore(join(dir, "link")).get("api-key"), /not a regular file/);
    const store = new CredentialStore(join(dir, "fresh", "credentials"));
    store.set("api-key", KEY);
    assert.deepEqual(JSON.parse(readFileSync(store.path, "utf8")), { "api-key": KEY });
    assert.throws(() => store.set("API KEY", KEY), /Not a credential name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a secret piped in is read whole, one trailing newline dropped", async () => {
  assert.equal(await readSecretFrom(Readable.from([`${KEY}\n`]), { write: () => true }, "api-key: "), KEY);
});

test("an unwritable config location names the credentials file, for set and for the last unset (C4)", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs POSIX permissions and a non-root user");
  const cli = makeCli({ secret: KEY });
  try {
    // The parent of the program's directory cannot be written: mkdir fails.
    const parent = join(cli.dir, "dip-bundestag");
    mkdirSync(cli.dir, { recursive: true });
    chmodSync(cli.dir, 0o500);
    assert.equal(await run(["config", "set", "api-key"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /Could not write the credentials file .*credentials: EACCES/);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
    chmodSync(cli.dir, 0o700);

    // The last name removed from a file in a directory that cannot be written: rm fails.
    cli.err.length = 0;
    cli.store.set("api-key", KEY);
    chmodSync(parent, 0o500);
    assert.equal(await run(["config", "unset", "api-key"], cli.deps), 1);
    assert.match(cli.err.join("\n"), /Could not write the credentials file .*credentials: EACCES/);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
    chmodSync(parent, 0o700);
    assert.equal(cli.store.get("api-key"), KEY, "nothing was lost");
  } finally {
    chmodSync(cli.dir, 0o700);
    cli.cleanup();
  }
});

test("config refuses -o: the value goes to stdout only, never silently to the terminal instead of a file (C10)", async () => {
  const cli = makeCli({ secret: KEY });
  try {
    cli.store.set("api-key", KEY);
    for (const argv of [
      ["-o", "key.txt", "config", "get", "api-key", "--reveal"],
      ["config", "get", "api-key", "--reveal", "-o", "key.txt"],
      ["--output=key.txt", "config", "get", "api-key"],
      ["-o", "key.txt", "config", "list"],
      ["-o", "key.txt", "config", "set", "api-key"],
      ["-o", "key.txt", "config", "unset", "api-key"],
    ]) {
      cli.out.length = 0;
      cli.err.length = 0;
      assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
      assert.deepEqual(cli.out, [], argv.join(" "));
      assert.match(cli.err.join("\n"), /ERROR \[dip\.cli\] dip config prints to stdout only/, argv.join(" "));
    }
    assert.equal(cli.store.get("api-key"), KEY, "unset did not run");
    // `-o -` is stdout, as everywhere.
    cli.out.length = 0;
    assert.equal(await run(["-o", "-", "config", "get", "api-key", "--reveal"], cli.deps), 0);
    assert.deepEqual(cli.out, [KEY]);
  } finally {
    cli.cleanup();
  }
});

/** Write the credentials file by hand, as a user editing it would. */
function handEdit(store: CredentialStore, content: Record<string, string>): void {
  mkdirSync(join(store.path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(store.path, JSON.stringify(content), { mode: 0o600 });
}

test("a hand-edited value config set would refuse is refused on read, naming the file (01-3, 02-1, 02-2)", async () => {
  for (const value of ["", "   ", "abc\u001b[31mRED-ghijklmnop", "AbCdEfG.line1\nline2-abcdefghijkl", "AbCdEfG.euro€-abcdefghijkl"]) {
    const cli = makeCli();
    try {
      handEdit(cli.store, { "api-key": value });
      const label = JSON.stringify(value);
      // A request: no key sent, no "the API key is sent" warning, no usage error.
      assert.equal(await run(["--base-url", "http://mirror.example", "vorgang", "list"], cli.deps), 1, label);
      assert.equal(cli.mt.calls.length, 0, `${label}: no request`);
      const err = cli.err.join("\n");
      assert.match(err, /ERROR \[dip\.cli\] The api-key stored in .*credentials cannot be used: .* dip config set api-key replaces it\./, label);
      assert.doesNotMatch(err, /Invalid apiKey|sent unencrypted/, label);
      // config get and config list: the same refusal, nothing raw on stdout.
      for (const argv of [["config", "get", "api-key"], ["config", "get", "api-key", "--reveal"], ["config", "list"]]) {
        cli.out.length = 0;
        assert.equal(await run(argv, cli.deps), 1, `${label} ${argv.join(" ")}`);
        assert.deepEqual(cli.out, [], `${label} ${argv.join(" ")}`);
      }
      // set and unset still repair it.
      assert.equal(await run(["config", "unset", "api-key"], cli.deps), 0, label);
    } finally {
      cli.cleanup();
    }
  }
});

test("a hand-edited value with surrounding spaces is used trimmed", async () => {
  const cli = makeCli();
  try {
    handEdit(cli.store, { "api-key": `  ${KEY}  ` });
    assert.equal(await run(["vorgang", "list"], cli.deps), 0);
    assert.equal(cli.mt.last().headers?.["Authorization"], `ApiKey ${KEY}`);
  } finally {
    cli.cleanup();
  }
});

test("config list refuses a hand-edited name that is not a credential name", async () => {
  const cli = makeCli();
  try {
    handEdit(cli.store, { "api-key": KEY, "x\u001b[31m": "abcdefghijklmnop" });
    assert.equal(await run(["config", "list"], cli.deps), 1);
    assert.deepEqual(cli.out, []);
    assert.match(cli.err.join("\n"), /holds "x\\u001b\[31m", which is not a credential name/);
  } finally {
    cli.cleanup();
  }
});

test("a 401 with the stored key says the key came from the credentials file, and how to replace it (02-3)", async () => {
  const cli = makeCli();
  try {
    cli.store.set("api-key", KEY);
    const deps: CliDeps = {
      ...cli.deps,
      createClient: (opts) => new DipClient({ ...opts, transport: async () => jsonResponse({ message: "Unauthorized" }, 401) }),
    };
    assert.equal(await run(["vorgang", "list"], deps), 1);
    const hint = cli.err.join("\n");
    assert.match(hint, /INFO  \[dip\.api\] Authentication failed \(401\) with the API key stored in .*credentials\./);
    assert.match(hint, /dip obtain-key \| dip config set api-key/);
    // A key from the flag gets the general hint, without the file.
    cli.err.length = 0;
    assert.equal(await run(["--api-key", "FLAGKEY1234", "vorgang", "list"], deps), 1);
    assert.doesNotMatch(cli.err.join("\n"), /stored in/);
    assert.match(cli.err.join("\n"), /Check your API key/);
  } finally {
    cli.cleanup();
  }
});
