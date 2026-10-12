import { z } from "zod";
import type { ChaaviCard, ChaaviItem } from "../../chaavi/client.js";
import { HathError } from "../../errors.js";
import { fail, ok } from "../shared.js";
import { defineTool } from "../types.js";
import { fillHidden } from "./call.js";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const EXPIRY_FORMATS = ["MM/YY", "MM/YYYY", "MM / YY", "MMYY"] as const;

const ref = z.string().min(1).optional();

const ADDRESS_REFS = {
  address1_ref: "address1",
  address2_ref: "address2",
  city_ref: "city",
  state_ref: "state",
  postal_code_ref: "postalCode",
  country_ref: "country",
} as const;

const input = z
  .object({
    item_id: z.string().min(1),
    browser_id: z.number().int().positive(),
    tab_id: z.string().min(1).optional(),
    name_ref: ref,
    number_ref: ref,
    exp_month_ref: ref,
    exp_year_ref: ref,
    exp_year_digits: z.union([z.literal(2), z.literal(4)]).optional(),
    expiry_ref: ref,
    expiry_format: z.enum(EXPIRY_FORMATS).optional(),
    code_ref: ref,
    identity_id: z.string().min(1).optional(),
    address1_ref: ref,
    address2_ref: ref,
    city_ref: ref,
    state_ref: ref,
    postal_code_ref: ref,
    country_ref: ref,
  })
  .strict()
  .superRefine((body, issue) => {
    const refs = Object.entries(body).filter(([key, value]) => key.endsWith("_ref") && value !== undefined);
    if (refs.length === 0) {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: "give at least one field ref" });
    }
    if ((body.expiry_ref === undefined) !== (body.expiry_format === undefined)) {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: "expiry_ref and expiry_format go together" });
    }
    const wantsAddress = Object.keys(ADDRESS_REFS).some((key) => body[key as keyof typeof ADDRESS_REFS] !== undefined);
    if (wantsAddress && body.identity_id === undefined) {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: "address refs need identity_id, the Chaavi identity with the billing address" });
    }
  });

type FillCardInput = z.infer<typeof input>;

/** One field to fill: its label in results, its ref, and the value in the ways a form may spell it. */
type CardField = { label: string; ref: string; forms: string[] };

/**
 * cardFields plans every requested fill before any is made, so a missing value fails the
 * call with nothing typed. A `<select>` matches any of a value's forms; a text field gets
 * the first.
 */
export function cardFields(parsed: FillCardInput, card: ChaaviCard, identity: ChaaviItem | null): CardField[] {
  const fields: CardField[] = [];
  const need = (value: string | null, what: string): string => {
    if (value === null) {
      throw new HathError(422, "invalid_request", `${what} is not in Chaavi`);
    }
    return value;
  };
  const month = () => {
    const n = Number(need(card.expMonth, "card expiry month"));
    const name = MONTHS[n - 1];
    if (name === undefined) {
      throw new HathError(422, "invalid_request", "card expiry month is not 1 to 12");
    }
    return { mm: String(n).padStart(2, "0"), m: String(n), name, short: name.slice(0, 3) };
  };
  const year = () => {
    const yyyy = need(card.expYear, "card expiry year");
    return { yyyy, yy: yyyy.slice(-2) };
  };
  if (parsed.name_ref !== undefined) {
    fields.push({ label: "name", ref: parsed.name_ref, forms: [need(card.cardholderName, "cardholder name")] });
  }
  if (parsed.number_ref !== undefined) {
    fields.push({ label: "number", ref: parsed.number_ref, forms: [card.number] });
  }
  if (parsed.exp_month_ref !== undefined) {
    const m = month();
    fields.push({ label: "expiry month", ref: parsed.exp_month_ref, forms: [m.mm, m.m, m.name, m.short] });
  }
  if (parsed.exp_year_ref !== undefined) {
    const y = year();
    fields.push({ label: "expiry year", ref: parsed.exp_year_ref, forms: parsed.exp_year_digits === 2 ? [y.yy, y.yyyy] : [y.yyyy, y.yy] });
  }
  if (parsed.expiry_ref !== undefined && parsed.expiry_format !== undefined) {
    const m = month();
    const y = year();
    const text = {
      "MM/YY": `${m.mm}/${y.yy}`,
      "MM/YYYY": `${m.mm}/${y.yyyy}`,
      "MM / YY": `${m.mm} / ${y.yy}`,
      MMYY: `${m.mm}${y.yy}`,
    }[parsed.expiry_format];
    fields.push({ label: "expiry", ref: parsed.expiry_ref, forms: [text] });
  }
  if (parsed.code_ref !== undefined) {
    fields.push({ label: "security code", ref: parsed.code_ref, forms: [need(card.code, "card security code")] });
  }
  for (const [key, property] of Object.entries(ADDRESS_REFS)) {
    const fieldRef = parsed[key as keyof typeof ADDRESS_REFS];
    if (fieldRef === undefined) {
      continue;
    }
    const details = identity?.identity;
    if (details === undefined) {
      throw new HathError(422, "invalid_request", "address refs need identity_id, the Chaavi identity with the billing address");
    }
    const value = details[property];
    fields.push({ label: property, ref: fieldRef, forms: [need(value, `identity ${property}`)] });
  }
  return fields;
}

/**
 * Fill a Chaavi card, and a billing address from a Chaavi identity, into a Nas browser
 * checkout form. No value appears in tool content or audit, and nothing is submitted.
 */
export const fillCard = defineTool({
  name: "chaavi_fill_card",
  description:
    "Fill a Chaavi card into a Nas browser checkout without seeing it: give the refs of the fields the form has (name on card, number, expiry month and year as separate fields or one expiry field with its format, security code), and with identity_id a Chaavi identity's billing address (address lines, city, state, postal code, country). Dropdowns are matched for you (a month as 08, 8, August or Aug; a year as 2029 or 29). Nothing is submitted. A payment or purchase is a write: before you call this, Ankur must have said yes to this specific purchase (what, from where, how much), asked in one line by the agent that would pay; a job or a schedule alone is not that yes. After the fill, read the page and submit only what he approved. Find the card with chaavi_list_items (type card) and the identity with type identity.",
  input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["item_id", "browser_id"],
    properties: {
      item_id: { type: "string", description: "Card item id from chaavi_list_items" },
      browser_id: { type: "number", description: "Nas browser id" },
      tab_id: { type: "string", description: "Optional CDP target id" },
      name_ref: { type: "string", description: "Ref of the name-on-card field" },
      number_ref: { type: "string", description: "Ref of the card number field" },
      exp_month_ref: { type: "string", description: "Ref of a separate expiry month field or dropdown" },
      exp_year_ref: { type: "string", description: "Ref of a separate expiry year field or dropdown" },
      exp_year_digits: {
        type: "number",
        enum: [2, 4],
        description: "Digits a separate year text field takes (default 4)",
      },
      expiry_ref: { type: "string", description: "Ref of a single expiry field; needs expiry_format" },
      expiry_format: {
        type: "string",
        enum: [...EXPIRY_FORMATS],
        description: "How the single expiry field writes the date, from its placeholder",
      },
      code_ref: { type: "string", description: "Ref of the security code (CVV) field" },
      identity_id: { type: "string", description: "Chaavi identity item id holding the billing address" },
      address1_ref: { type: "string", description: "Ref of the first address line" },
      address2_ref: { type: "string", description: "Ref of the second address line" },
      city_ref: { type: "string", description: "Ref of the city field" },
      state_ref: { type: "string", description: "Ref of the state field or dropdown" },
      postal_code_ref: { type: "string", description: "Ref of the postal code field" },
      country_ref: { type: "string", description: "Ref of the country field or dropdown" },
    },
  },
  async handler(ctx, parsed) {
    try {
      const card = await ctx.chaavi.getCard(parsed.item_id);
      let identity: ChaaviItem | null = null;
      if (parsed.identity_id !== undefined) {
        identity = await ctx.chaavi.getItem(parsed.identity_id);
        if (identity.type !== "identity") {
          return fail(`invalid_request: item ${parsed.identity_id} is a ${identity.type}, not an identity`);
        }
      }
      const fields = cardFields(parsed, card, identity);
      const hidden = [
        card.number,
        card.code,
        card.cardholderName,
        ...fields.flatMap((field) => field.forms),
      ].filter((value): value is string => value !== null);
      for (const field of fields) {
        await fillHidden(
          () => ctx.browsers.fillField(parsed.browser_id, parsed.tab_id, field.ref, field.forms),
          field.label,
          field.ref,
          hidden,
        );
      }
      return ok(
        {
          filled: fields.map((field) => field.label),
          item_id: parsed.item_id,
          ...(parsed.identity_id !== undefined ? { identity_id: parsed.identity_id } : {}),
          browser_id: parsed.browser_id,
        },
        {
          item_id: parsed.item_id,
          browser_id: parsed.browser_id,
          ...(parsed.tab_id !== undefined ? { tab_id: parsed.tab_id } : {}),
        },
      );
    } catch (err) {
      if (err instanceof HathError) {
        return fail(`${err.type}: ${err.message}`);
      }
      throw err;
    }
  },
});
