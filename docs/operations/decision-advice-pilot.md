# Run the pending-decision advice pilot

This opt-in experiment covers pending run-backed `engine_collision` and genuine
`engine_prepare_profile_mismatch` decisions with two distinct non-decline actions.
The recommendation can only name an existing action or abstain. The operator
still chooses and resolves the action. See [issue #719](https://github.com/deeeed/farmslot/issues/719)
and the [evaluation plan](../plans/structured-assessment-evaluation.md).

1. Inspect the pending run decision and its action descriptions. Confirm the
   entire description and each non-decline action are safe to send to the
   chosen provider. A `manual` task label does not establish source approval.
2. Set `FARMSLOT_DECISION_ADVICE_ENABLED=true`, select an assessment provider
   and model using `FARMSLOT_ASSESSMENT_PROVIDER` and
   `FARMSLOT_ASSESSMENT_MODEL`, and configure that provider's credential in
   the gateway environment. An enabled provider alone does not request advice.
3. Call `decision.advice.get` with `{ "runId": "...", "decisionId": "..." }`.
   Before admission it returns `reason: "not-admitted"` and a
   `snapshotHash`. Verify that the snapshot corresponds to the reviewed
   decision. Copy the exact hash into an operator-maintained
   `$FARMSLOT_HOME/decision-advice-policy.json`:

   ```json
   {
     "version": 1,
     "price": {
       "version": 1,
       "provider": "typesafe",
       "model": "jev-1.13.0",
       "verifiedAt": "YYYY-MM-DDTHH:mm:ss.sssZ",
       "source": "https://provider.example/pricing",
       "inputUsdPerMillion": 1,
       "outputUsdPerMillion": 0,
       "maxInputTokens": 4096,
       "maxOutputTokens": 512
     },
     "limits": { "maxCalls": 1, "maxUsd": 0.01 },
     "entries": [
       {
         "runId": "RUN_ID",
         "decisionId": "DECISION_ID",
         "snapshotHash": "EXACT_64_CHARACTER_HASH",
         "classification": "synthetic",
         "sourceRef": "synthetic:case-reference"
       }
     ]
   }
   ```

   **The sample prices are placeholders.** Replace every price, token bound,
   date, source and identifier with independently verified values before use.
   Mark an actual public source `public` and provide its HTTPS reference;
   do not relabel private data as synthetic. Only zero-priced output is
   eligible until a provider-enforced output limit is available. Pricing
   older than seven days is rejected.

4. Refresh the decision panel. `decision.advice.get` shows admission without
   making a model call. Press **Get recommendation** once to request an
   assessment. Inspect its saved answer, attempted call, provider/model,
   usage and cost in the panel and assessment history. Missing usage remains
   an unknown charge. Do not repeat a request to improve a weak answer.

The [synthetic cases and blinded labels](../../scripts/decision-advice/README.md)
are for the controlled classification study. Current collision packets lack operator
intent and prior-run safety facts, so those cases call for abstention. A saved
action ID proves display and validation, not decision quality. Freeze cases and
labels before candidate calls, then collect paired human decisions at equal
adjudicated quality for an efficiency claim. Without paired time, total model tokens and cost, the
impact remains unknown.
