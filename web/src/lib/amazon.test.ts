import { describe, expect, it } from "vitest";
import { groceryCharges, matchCharges, parseAmazonTransactions, type BankTx } from "./amazon";

// Synthetic page text in the shape of Amazon's Transactions page (made-up orders and cards).
const PAGE = `
Nov 08, 2026·Amazon.com
Visa••••1111
Order #111-0000001-0000001
-$61.20
Pending
Nov 02, 2026·Amazon Tips
Visa••••1111
Order #111-0000002-0000002
-$8.00
Charged
Nov 01, 2026·Amazon.com
Visa••••1111
Order #111-0000002-0000002
-$84.37
Charged
Nov 01, 2026·AMZN Mktp US
Visa••••1111
Order #111-0000003-0000003
-$19.99
Charged
Oct 30, 2026·Amazon.com
Visa••••1111
Order #111-0000002-0000002
+$4.10
Refunded
Oct 20, 2026·AMZN Mktp US
Visa••••2222
Order #111-0000004-0000004
-$12.00
Charged
`;

describe("parseAmazonTransactions", () => {
  it("parses entries with sign, card, order and status", () => {
    const c = parseAmazonTransactions(PAGE);
    expect(c).toHaveLength(6);
    expect(c[1]).toEqual({
      date: "2026-11-02",
      descriptor: "Amazon Tips",
      last4: "1111",
      orderId: "111-0000002-0000002",
      amount: 8,
      status: "charged",
    });
    expect(c[4].amount).toBe(-4.1); // refund = money in
    expect(c[0].status).toBe("pending");
  });

  it("ignores junk and incomplete entries, and handles thousands separators", () => {
    const c = parseAmazonTransactions(
      "Your Payments\nTransactions\nFeb 30, 2026·Bad date\n-$1.00\nJan 05, 2026·No amount\nVisa••••1111\nJan 04, 2026·Big\n-$1,234.56\n",
    );
    expect(c).toEqual([
      { date: "2026-01-04", descriptor: "Big", last4: null, orderId: null, amount: 1234.56, status: null },
    ]);
    expect(parseAmazonTransactions("")).toEqual([]);
  });
});

describe("groceryCharges", () => {
  it("takes every non-pending charge of an order that has a tip", () => {
    const g = groceryCharges(parseAmazonTransactions(PAGE));
    expect(g.orders).toBe(1);
    expect(g.charges.map((c) => c.amount)).toEqual([8, 84.37, -4.1]);
  });
});

describe("matchCharges", () => {
  let id = 1;
  const tx = (date: string, amount: number, over: Partial<BankTx> = {}): BankTx => ({
    id: id++,
    date,
    amount,
    pending: false,
    name: "AMAZON MKTPL*XX1",
    merchantName: "Amazon",
    mask: "1111",
    ...over,
  });

  it("matches by card, exact amount and date window, one-to-one, closest first", () => {
    const charges = groceryCharges(parseAmazonTransactions(PAGE)).charges;
    const tip = tx("2026-11-03", 8, { name: "Amazon Tips*ZZ" });
    const order = tx("2026-11-02", 84.37);
    const refund = tx("2026-10-31", -4.1);
    const decoys = [
      tx("2026-11-12", 84.37), // too late
      tx("2026-11-02", 84.37, { mask: "9999" }), // other card
      tx("2026-11-02", 84.36), // a cent off
      tx("2026-11-02", 84.37, { name: "WHOLEFDS", merchantName: "Whole Foods" }), // not Amazon
      tx("2026-11-02", 84.37, { pending: true }),
    ];
    const farther = tx("2026-11-05", 84.37); // also in window, but farther than `order`
    const m = matchCharges(charges, [...decoys, farther, tip, order, refund]);
    expect([...m].sort()).toEqual([tip.id, order.id, refund.id].sort());
  });

  it("never matches two charges to one bank row", () => {
    const charges = parseAmazonTransactions(
      "Nov 01, 2026·Amazon Tips\nVisa••••1111\nOrder #A-1\n-$5.00\nCharged\nNov 01, 2026·Amazon Tips\nVisa••••1111\nOrder #A-2\n-$5.00\nCharged\n",
    );
    expect(matchCharges(charges, [tx("2026-11-02", 5)]).size).toBe(1);
  });
});
