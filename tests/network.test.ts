import { describe, expect, it } from "vitest";
import { isPublicAddress, resolvePublicAddress, UnsafeDestinationError } from "../src/network.js";

describe("Outbound webhook addresses", () => {
  it("allows public IPv4 and IPv6 addresses", () => {
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("blocks local, reserved, shared and documentation networks", () => {
    for (const address of [
      "127.0.0.1", "10.2.3.4", "172.16.1.2", "192.168.1.5",
      "169.254.169.254", "100.64.0.1", "0.0.0.0", "198.51.100.7",
      "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "2002::1"
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("pins an allowed DNS answer and rejects mixed public/private records", async () => {
    const address = await resolvePublicAddress("receiver.example", async () => [
      { address: "93.184.216.34", family: 4 }
    ]);
    expect(address.address).toBe("93.184.216.34");

    await expect(resolvePublicAddress("receiver.example", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.1.2.3", family: 4 }
    ])).rejects.toBeInstanceOf(UnsafeDestinationError);
    await expect(resolvePublicAddress("receiver.example", async () => []))
      .rejects.toBeInstanceOf(UnsafeDestinationError);
  });
});
