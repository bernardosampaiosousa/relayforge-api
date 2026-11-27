import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { sendWebhook, UnsafeDestinationError } from "../src/network.js";

describe("HTTPS webhook transport", () => {
  it("uses the validated IP for the connection but keeps the hostname for TLS", async () => {
    const closeResponse = vi.fn();
    const requestMock = vi.fn((_url, options, onResponse) => {
      const outbound = new EventEmitter() as EventEmitter & { end: (body: string) => void };
      outbound.end = body => {
        expect(body).toBe('{"event":"created"}');
        options.lookup("receiver.example", {}, (error, address, family) => {
          expect(error).toBeNull();
          expect(address).toBe("93.184.216.34");
          expect(family).toBe(4);
        });
        onResponse({ statusCode: 204, destroy: closeResponse });
      };
      expect(options.servername).toBe("receiver.example");
      expect(options.agent).toBe(false);
      expect(options.autoSelectFamily).toBe(false);
      return outbound;
    });

    const status = await sendWebhook(
      "https://receiver.example/hooks", '{"event":"created"}', {},
      async () => [{ address: "93.184.216.34", family: 4 }],
      requestMock as unknown as typeof import("node:https").request
    );
    expect(status).toBe(204);
    expect(requestMock).toHaveBeenCalledOnce();
    expect(closeResponse).toHaveBeenCalledOnce();
  });

  it("does not open a socket for a hostname with a private DNS answer", async () => {
    const requestMock = vi.fn();
    await expect(sendWebhook(
      "https://receiver.example/hooks", "{}", {},
      async () => [{ address: "10.0.0.8", family: 4 }],
      requestMock as unknown as typeof import("node:https").request
    )).rejects.toBeInstanceOf(UnsafeDestinationError);
    expect(requestMock).not.toHaveBeenCalled();
  });
});
