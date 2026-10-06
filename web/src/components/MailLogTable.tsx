import { Fragment } from "react";
import { Link } from "react-router-dom";
import type { MailLogRow } from "../api/client";

/** What each status means for the message, in the admin's terms. */
const STATUS: Record<string, { label: string; tone: string; meaning: string }> = {
  signed: { label: "Signed", tone: "text-teal-800", meaning: "Signed and handed back" },
  "passed-through": { label: "Passed through", tone: "text-stone-600", meaning: "No signature applied; handed back unchanged" },
  "loop-prevented": { label: "Already signed", tone: "text-stone-600", meaning: "Already processed; handed back unchanged" },
  error: { label: "Unsigned", tone: "text-amber-800", meaning: "Delivered without a signature" },
  deferred: { label: "Deferred", tone: "text-red-700", meaning: "Not delivered yet; Microsoft 365 / Google will retry" }
};

const PROBLEM = new Set(["error", "deferred"]);

export function MailLogTable({ rows, empty }: { rows: MailLogRow[]; empty: string }) {
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-mist text-left text-stone-500">
          <tr>
            <th className="p-3 font-medium">When</th>
            <th className="font-medium pr-3">From</th>
            <th className="font-medium pr-3">To</th>
            <th className="font-medium pr-3">Status</th>
            <th className="font-medium pr-3 text-right">ms</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const status = STATUS[r.status] ?? { label: r.status, tone: "", meaning: "" };
            const to = r.recipients ?? [];
            return (
              <Fragment key={i}>
                <tr className="border-t border-line align-top">
                  <td className="p-3 whitespace-nowrap">{new Date(r.receivedAt).toLocaleString()}</td>
                  <td className="py-3 pr-3">{r.sender}</td>
                  <td className="py-3 pr-3">
                    {to.slice(0, 2).join(", ")}
                    {to.length > 2 && ` +${to.length - 2}`}
                  </td>
                  <td className={`py-3 pr-3 font-medium ${status.tone}`} title={status.meaning}>
                    {status.label}
                  </td>
                  <td className="py-3 pr-3 text-right">{r.processingMs}</td>
                </tr>
                {PROBLEM.has(r.status) && r.detail && (
                  <tr>
                    <td colSpan={5} className="px-3 pb-3">
                      <div
                        className={`rounded-lg p-3 text-xs leading-5 break-words ${
                          r.status === "deferred" ? "bg-red-50 text-red-900" : "bg-amber-50 text-amber-900"
                        }`}
                      >
                        <span className="font-semibold">{status.meaning}. </span>
                        {r.detail}
                        {r.status === "deferred" && (
                          <>
                            {" "}
                            <Link to="/settings#return-path" className="underline font-medium">
                              Test the return path
                            </Link>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td className="p-4 text-stone-500" colSpan={5}>
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
