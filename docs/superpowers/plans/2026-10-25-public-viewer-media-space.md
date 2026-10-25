# Reserve public Timeline media space

## Goal and scope
Fix the public viewer layout shift exposed by the actual S25 Ultra source-qualification trace. Existing verified image dimensions must reserve layout space before response bytes arrive, for both cover and story images. Preserve media authorization, natural aspect ratios, responsive width and existing height limits. No schema change, new dependency, provider tracking change, or formal-performance pass claim.

## Evidence and design
The public item query omits Asset width/height, and renderTimeline emits images without intrinsic dimensions. Two observed no-input LayoutShift events moved captions and subsequent items. Propagate stored dimensions through the server-rendered viewer. Only emit dimension attributes for a valid positive finite integer pair; unknown/invalid dimensions retain current fallback. Prefer native width/height sizing, with CSS changes only if a delayed-media geometry test proves necessary. Do not invent media dimensions or expose private metadata.

## Task 1: Regression and minimum fix
1. Read renderer, public route, Asset model, shared media utilities and existing public-viewer fixtures/tests.
2. Run existing scoped integration baseline. Add failing real-D1 assertions that cover and story image dimensions come from each Asset, including portrait/landscape/square and missing/invalid pairs. Preserve escaping and permission behavior.
3. Add desktop/mobile browser regression using real local viewer and delayed image responses: before bytes release, image/figcaption geometry is reserved; after image decode the caption and following-item positions do not shift (allow <=1 CSS px rounding). Include height-constrained portrait, landscape and cover cases. Unknown dimensions still render safely. The test must fail against current source for the missing reserved space.
4. Make the smallest query/type/renderer/CSS change needed; run scoped integration and delayed-image browser checks RED then GREEN. Match existing project style. No installs; shared node_modules must remain untouched.
5. Run full npm run check once after scoped checks, retaining exact terminal result and known preexisting skip. Capture synthetic browser proof. Do not change timeouts to hide failure.

## Review and delivery
Fresh independent task review then whole-branch review. Fix findings and re-run required checks. Commit only scoped implementation/tests/this plan; preserve HANDOFF. Push a separate PR to main and require final-commit CI before merge. Preview deployment requires a concrete version-specific authorization. Re-measure the same S25 source after authorized deployment; a local regression does not prove live CLS improvement or close formal 6720-trial acceptance.
