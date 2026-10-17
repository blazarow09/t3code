import { expect, it } from "vite-plus/test";
import { BoundedTerminalHistory } from "./Manager.ts";

function fixture(maxLines = 5, maxBytes = 128) {
  const history = new BoundedTerminalHistory(maxLines, "", maxBytes);
  let disk = "";
  const persist = (compact = false) => {
    const write = history.prepareWrite(compact);
    if (write) {
      const encoded = Buffer.from(write.data).toString();
      disk = write.flag === "a" ? disk + encoded : encoded;
      write.commit();
    }
    return write;
  };
  const verify = () => {
    const restored = new BoundedTerminalHistory(maxLines, disk, maxBytes).value();
    expect(restored).toBe(Buffer.from(history.value()).toString());
    expect(Buffer.byteLength(disk)).toBeLessThanOrEqual(maxBytes * 2);
  };
  return { history, persist, verify, disk: () => disk };
}

it("persists deltas and skips unchanged checkpoints without losing bounded replay", () => {
  const f = fixture(5000, 1024 * 1024);
  f.history.append("x".repeat(256 * 1024));
  expect(f.persist()?.flag).toBe("w");
  f.history.append("new output");
  expect(f.persist()?.data).toBe("new output");
  expect(f.persist()).toBeUndefined();
  expect(f.persist(true)).toBeUndefined();
  f.verify();
});

it("compacts rolling byte and line histories while retaining exact replay", () => {
  for (const maxBytes of [4, 32, 4096]) {
    for (const maxLines of [1, 5]) {
      const f = fixture(maxLines, maxBytes);
      for (let i = 0; i < 100; i++) {
        f.history.append("line-" + i + " 😀\n");
        f.persist();
        f.verify();
      }
      f.persist(true);
      expect(f.disk()).toBe(f.history.value());
      expect(Buffer.byteLength(f.disk())).toBeLessThanOrEqual(maxBytes);
    }
  }
});

it("preserves arbitrary chunk boundaries, ANSI, Unicode and clears across persistence", () => {
  const chunks = ["abc", "\n", "\r", "😀", "é", "\u001b[32m", "\ud83d", "\ude00", "x".repeat(137)];
  for (const maxBytes of [0, 3, 17, 128]) {
    const f = fixture(5, maxBytes);
    let seed = 71;
    for (let i = 0; i < 400; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      if (i % 37 === 0) f.history.clear();
      f.history.append(chunks[seed % chunks.length]!);
      f.persist(i % 13 === 0);
      f.verify();
    }
  }
});

it("rewrites a split surrogate that crossed a successful UTF-8 write", () => {
  const f = fixture();
  f.history.append("hello \ud83d");
  f.persist();
  f.history.append("\ude00");
  expect(f.persist()?.flag).toBe("w");
  expect(f.disk()).toBe("hello 😀");
});

it("preserves output and clear arriving during an in-flight write", () => {
  const f = fixture();
  f.history.append("before");
  const inFlight = f.history.prepareWrite()!;
  f.history.append(" after");
  inFlight.commit();
  expect(f.history.prepareWrite()?.data).toBe(" after");
  f.history.clear();
  f.history.append("new generation");
  inFlight.commit();
  expect(f.persist()?.flag).toBe("w");
  expect(f.disk()).toBe("new generation");
});

it("replaces potentially partial failed appends on retry", () => {
  const f = fixture();
  f.history.append("before");
  f.persist();
  f.history.append(" after");
  expect(f.history.prepareWrite()?.flag).toBe("a");
  f.history.invalidatePersistence();
  f.history.append(" retry");
  expect(f.persist()?.flag).toBe("w");
  expect(f.disk()).toBe("before after retry");
});
