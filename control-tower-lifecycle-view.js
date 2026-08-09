(function attachLifecycleView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ControlTowerLifecycleView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createLifecycleView() {
  "use strict";

  const ROWS = Object.freeze([
    { key: "ESCALATED_TO_ADMIN", title: "Exceptions / Escalated-to-Admin", label: "Escalated to Admin", color: "#FFD6D6", description: "Administrator attention required" },
    { key: "WAITING_FOR_BUSINESS_HOURS", title: "Waiting for Business Hours", label: "Waiting for Business Hours", color: "#1F3A5F", description: "Held until the service window opens", dark: true },
    { key: "NEW", title: "New", label: "New", color: "#BFFBB6", description: "Initial response is pending" },
    { key: "REMINDER_SENT", title: "Reminder Sent", label: "Reminder Sent", color: "#D9EEFF", description: "A response reminder is active" },
    { key: "WAITING_FOR_OUTCOME_RESPONSE", title: "Waiting for Outcome Response", label: "Waiting for Outcome Response", color: "#E8E0FF", description: "A contact attempt needs an outcome" },
    { key: "AT_RISK", title: "At Risk", label: "At Risk", color: "#FFF0B8", description: "The final reminder window is active" }
  ]);

  const ROW_BY_KEY = new Map(ROWS.map(row => [row.key, row]));

  function buildLifecycleRows(leads, serviceWindow) {
    const visible = (Array.isArray(leads) ? leads : []).filter(lead => {
      return lead?.lifecycle?.presentation_ready === true &&
        lead.lifecycle.is_active !== false &&
        ROW_BY_KEY.has(lead.lifecycle.key);
    });

    return ROWS.map(row => {
      let items = visible.filter(lead => lead.lifecycle.key === row.key);
      if (row.key === "WAITING_FOR_BUSINESS_HOURS" && serviceWindow?.is_open === true) {
        items = [];
      }

      items.sort((left, right) => timestamp(left.received_ts_utc) - timestamp(right.received_ts_utc));
      return {
        ...row,
        items,
        empty_text: row.key === "WAITING_FOR_BUSINESS_HOURS" && serviceWindow?.is_open === true
          ? "Business hours are open. No leads are being held for release."
          : "No active leads in this stage."
      };
    });
  }

  function summaryItems(summary) {
    return [
      ["Active Leads", numberOrZero(summary?.active_leads)],
      ["At Risk", numberOrZero(summary?.at_risk)],
      ["Escalated to Admin", numberOrZero(summary?.escalated_to_admin)],
      ["Avg. Response Time", textOrFallback(summary?.avg_response_time?.display, "-")]
    ];
  }

  function cardClassFor(key) {
    return ROW_BY_KEY.has(key) ? `lead-card lifecycle-${key.toLowerCase().replaceAll("_", "-")}` : "lead-card";
  }

  function carouselState({ scrollLeft = 0, clientWidth = 0, scrollWidth = 0 } = {}) {
    const max = Math.max(0, scrollWidth - clientWidth - 1);
    return {
      show_left: scrollLeft > 1,
      show_right: scrollLeft < max
    };
  }

  function timestamp(value) {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  }

  function numberOrZero(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function textOrFallback(value, fallback) {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  return { ROWS, buildLifecycleRows, cardClassFor, carouselState, summaryItems };
});
