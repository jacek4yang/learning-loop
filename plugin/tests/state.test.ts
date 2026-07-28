import { describe, expect, it } from "vitest";

import { MemoryStateRepository } from "../src/sync/state";

describe("state repository serialization", () => {
  it("continues after a rejected atomic transform", async () => {
    const repository = new MemoryStateRepository();
    await expect(repository.update(() => {
      throw new Error("injected transform failure");
    })).rejects.toThrow("injected transform failure");

    const recovered = await repository.update((state) => ({
      ...state,
      lamport: "1",
    }));
    expect(recovered.lamport).toBe("1");
    expect((await repository.read()).lamport).toBe("1");
  });
});
