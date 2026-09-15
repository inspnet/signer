import { newBlockId, type Design } from "./design.js";

const body = { fontFamily: "Calibri, Arial, sans-serif", fontSize: 13, color: "#1c1917" };
const muted = { fontFamily: "Calibri, Arial, sans-serif", fontSize: 12, color: "#57534e" };

export function defaultProfessionalDesign(): Design {
  return {
    width: 520,
    background: "#ffffff",
    blocks: [
      {
        id: newBlockId(),
        type: "field",
        field: "displayName",
        style: { ...body, fontSize: 18, color: "#0f766e", bold: true }
      },
      {
        id: newBlockId(),
        type: "field",
        field: "jobTitle",
        style: muted
      },
      {
        id: newBlockId(),
        type: "field",
        field: "department",
        style: muted
      },
      { id: newBlockId(), type: "spacer", height: 8 },
      { id: newBlockId(), type: "divider", color: "#0f766e", height: 2 },
      { id: newBlockId(), type: "spacer", height: 10 },
      {
        id: newBlockId(),
        type: "field",
        field: "email",
        link: "email",
        style: body
      },
      {
        id: newBlockId(),
        type: "field",
        field: "telephone",
        prefix: "T ",
        link: "phone",
        style: body
      },
      {
        id: newBlockId(),
        type: "field",
        field: "website",
        link: "url",
        style: { ...body, color: "#0f766e" }
      },
      { id: newBlockId(), type: "spacer", height: 10 },
      {
        id: newBlockId(),
        type: "field",
        field: "custom1",
        style: { ...muted, fontSize: 11 }
      },
      {
        id: newBlockId(),
        type: "field",
        field: "custom2",
        style: { ...muted, fontSize: 11 }
      }
    ]
  };
}
