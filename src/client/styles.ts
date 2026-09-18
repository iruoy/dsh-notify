// Match DSH's settings chrome and inherit its light/dark theme tokens.
export const styles = `
.dn{width:100%;max-width:760px;min-width:0;font-family:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}
.dn *{box-sizing:border-box}
.dn h2{margin:0;font-size:18px;font-weight:600;line-height:1.5}
.dn h3{margin:24px 0 8px;font-size:15px;font-weight:600;line-height:22px}
.dn p{margin:6px 0 12px}
.dn-heading{margin-bottom:20px}
.dn-heading p{margin:8px 0 0;font-size:13px}
.dn fieldset{min-width:0;margin:0 0 20px;padding:0 0 20px;border:0;border-bottom:.5px solid var(--dsw-alias-border-l2,#8884)}
.dn legend{width:100%;margin:0 0 12px;padding:0;font-size:15px;font-weight:600;line-height:22px}
.dn label{display:flex;gap:8px;align-items:center;min-width:0}
.dn input[type=checkbox]{accent-color:var(--dsw-alias-brand-primary,#4d6bfe);width:16px;height:16px;margin:0;flex-shrink:0;cursor:pointer}
.dn-row{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;font-size:14px;line-height:22px}
.dn-muted{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;font-weight:400}
.dn-field{align-items:stretch!important;flex-direction:column;gap:6px!important;margin:12px 0 6px;font-weight:500}
.dn input[type=url],.dn input[type=password]{width:100%;min-width:0;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4,#8885);border-radius:8px;font:inherit;font-weight:400;background:var(--dsw-alias-bg-layer-3,transparent);color:var(--dsw-alias-label-primary,inherit)}
.dn input::placeholder{color:var(--dsw-alias-label-tertiary,#888)}
.dn-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.dn button{min-height:32px;border:.5px solid var(--dsw-alias-border-l4,#8885);border-radius:8px;padding:5px 12px;background:var(--dsw-alias-bg-layer-3,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-weight:500;cursor:pointer}
.dn button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8882)}
.dn button:disabled{opacity:.4;cursor:default}
.dn .dn-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;border-color:transparent}
.dn .dn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#4d6bfe);filter:brightness(.92)}
.dn :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}
.dn-events{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 20px;margin:16px 0 0}
.dn-events + label{margin-top:20px}
.dn-message:empty{display:none}
.dn-message{padding:10px 12px;background:var(--dsw-alias-bg-layer-3,#8881);border-radius:8px;margin:0 0 16px}
.dn-error{color:var(--dsw-alias-state-error-primary,#dc6b54);font-size:12px}
.dn-empty{color:var(--dsw-alias-label-tertiary,#888);font-size:13px}
.dn-table{overflow-x:auto}
.dn table{width:100%;border-collapse:collapse;font-size:12px;text-align:left}
.dn th{font-weight:500;color:var(--dsw-alias-label-tertiary,#888)}
.dn th,.dn td{padding:10px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2,#8884);vertical-align:top}
.dn th:first-child,.dn td:first-child{padding-left:0}
.dn td:first-child{max-width:290px;overflow-wrap:anywhere}
.dn td strong{font-weight:500}
@media(max-width:560px){.dn-events{grid-template-columns:1fr}.dn-row{align-items:flex-start}.dn-actions button{max-width:100%}}
`;
