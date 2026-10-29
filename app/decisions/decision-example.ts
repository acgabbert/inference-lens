import type { DecisionInput } from "../../packages/core/src/decision";

/**
 * The worked example "Load example" puts in the editor: one support ticket,
 * asked one question of each type, so a first run shows every answer shape.
 */
export const DECISION_EXAMPLE: DecisionInput = {
  state:
    "Subject: Charged twice this month\n\n"
    + "Hi, my card was billed two times for the Pro plan on the 3rd. "
    + "I need one of those refunded before my rent is due on Friday. Thanks, Sam",
  questions: {
    intent: {
      type: "choice",
      instructions: "What is the customer asking for help with?",
      criteria: {
        billing: "Charges, refunds, invoices, or plan changes",
        bug: "Something in the product is broken",
        other: null,
      },
    },
    severity: {
      type: "score",
      instructions: "How urgent is this ticket?",
      criteria: ["can wait", "needs a reply today", "needs a reply within the hour"],
    },
    is_spam: {
      type: "noul",
      instructions: "Is this message spam?",
      criteria: { true: "Unsolicited advertising or a scam", false: "A genuine customer message" },
    },
  },
};
