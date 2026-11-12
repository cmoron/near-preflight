// docs/quickcheck.js encodes its calls by hand (no dependency in the page): each against viem's encoding.
import { expect, test } from "bun:test";
import { encodeAbiParameters, encodeFunctionData, parseAbi } from "viem";
// @ts-expect-error a plain browser module, without types
import { abi, reason } from "./quickcheck.js";

const WETH = "0x4200000000000000000000000000000000000006";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WHO = "0xabcdef0123456789abcdef0123456789abcdef01";
const N = 123456789012345678901234567890n;
const ref = parseAbi([
  "function getPair(address,address) view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function owner() view returns (address)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
]);
const viem = (functionName: string, args: unknown[] = []) => encodeFunctionData({ abi: ref, functionName, args } as never);

test("quickcheck.js encodes its calls as viem does", () => {
  expect(abi.getPair(TOKEN, WETH)).toBe(viem("getPair", [TOKEN, WETH]));
  expect(abi.getReserves()).toBe(viem("getReserves"));
  expect(abi.owner()).toBe(viem("owner"));
  expect(abi.decimals()).toBe(viem("decimals"));
  expect(abi.symbol()).toBe(viem("symbol"));
  expect(abi.approve(WHO, N)).toBe(viem("approve", [WHO, N]));
  expect(abi.transferFrom(WHO, TOKEN, 1n)).toBe(viem("transferFrom", [WHO, TOKEN, 1n]));
  expect(abi.buy(TOKEN, WHO, 1794500000n)).toBe(viem("swapExactETHForTokensSupportingFeeOnTransferTokens", [0n, [WETH, TOKEN], WHO, 1794500000n]));
  expect(abi.sell(TOKEN, N, WHO, 1794500000n)).toBe(viem("swapExactTokensForETHSupportingFeeOnTransferTokens", [N, 0n, [TOKEN, WETH], WHO, 1794500000n]));
});

test("quickcheck.js reads a revert's reason", () => {
  const error = (s: string) => `0x08c379a0${encodeAbiParameters([{ type: "string" }], [s]).slice(2)}`;
  expect(reason({ error: { data: error("sale closed") } })).toBe("sale closed");
  expect(reason({ returnData: error("ERC20: transfer amount exceeds allowance") })).toBe("ERC20: transfer amount exceeds allowance");
  expect(reason({ returnData: "0x4e487b710000000000000000000000000000000000000000000000000000000000000011" })).toBe("panic 0x11");
  expect(reason({ returnData: "0x" })).toBe("revert without reason");
  expect(reason({ returnData: "0xfb8f41b200000000000000000000000000000000000000000000000000000000000000aa" })).toBe("0xfb8f41b200000000");
});
