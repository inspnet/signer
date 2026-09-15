import { newBlockId, type Design } from "./design.js";

export function defaultProfessionalDesign(): Design {
  return {
    width: 460,
    background: "#ffffff",
    blocks: [
      {
        id: newBlockId(),
        type: "row",
        columns: [
          {
            width: "100%",
            blocks: [
              {
                id: newBlockId(),
                type: "field",
                field: "displayName",
                style: { fontFamily: "Calibri, Arial, sans-serif", fontSize: 16, color: "#111827", bold: true }
              },
              {
                id: newBlockId(),
                type: "field",
                field: "jobTitle",
                style: { fontFamily: "Calibri, Arial, sans-serif", fontSize: 12, color: "#4b5563" }
              },
              {
                id: newBlockId(),
                type: "field",
                field: "department",
                style: { fontFamily: "Calibri, Arial, sans-serif", fontSize: 12, color: "#4b5563" }
              }
            ]
          }
        ]
      },
      { id: newBlockId(), type: "spacer", height: 10 },
      {
        id: newBlockId(),
        type: "image",
        src: "",
        alt: "Company logo",
        width: 160
      },
      { id: newBlockId(), type: "spacer", height: 8 },
      {
        id: newBlockId(),
        type: "field",
        field: "telephone",
        prefix: "",
        link: "phone",
        style: { fontFamily: "Calibri, Arial, sans-serif", fontSize: 12, color: "#111827" }
      },
      {
        id: newBlockId(),
        type: "field",
        field: "email",
        link: "email",
        style: { fontFamily: "Calibri, Arial, sans-serif", fontSize: 12, color: "#111827" }
      },
      {
        id: newBlockId(),
        type: "field",
        field: "website",
        link: "url",
        style: { fontFamily: "Calibri, Arial, sans-serif", fontSize: 12, color: "#111827" }
      },
      { id: newBlockId(), type: "spacer", height: 8 },
      {
        id: newBlockId(),
        type: "field",
        field: "custom1",
        style: { fontFamily: "Calibri, Arial, sans-serif", fontSize: 11, color: "#6b7280" }
      },
      {
        id: newBlockId(),
        type: "field",
        field: "custom2",
        style: { fontFamily: "Calibri, Arial, sans-serif", fontSize: 11, color: "#6b7280" }
      }
    ]
  };
}
