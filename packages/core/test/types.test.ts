import { createReviewer, type Backend, type ReviewResult } from '../src/index.js';

const backend: Backend = async ({ request, policy, responseSchema }, { signal }) => {
  const policyText: string = policy.text;
  const schema: Readonly<Record<string, unknown>> = responseSchema;
  const aborted: boolean = signal.aborted;
  // @ts-expect-error A backend must not mutate the review snapshot.
  request.action.arguments.command = 'changed';
  return { output: JSON.stringify({ policyText, schema, aborted }) };
};
const reviewer = createReviewer({ backend });
const result: ReviewResult = await reviewer.review(null);
if (result.status === 'result') {
  const decision: 'allow' | 'ask' | 'deny' = result.decision;
  // @ts-expect-error A caller must not rewrite a completed decision.
  result.decision = decision;
} else {
  const code: string = result.code;
  // @ts-expect-error Technical errors do not carry model decisions.
  const decision = result.decision;
  void code;
  void decision;
}
