export const DIRECTORY_FIELDS = [
  { key: "displayName", label: "Display name" },
  { key: "givenName", label: "First name" },
  { key: "surname", label: "Last name" },
  { key: "pronouns", label: "Pronouns" },
  { key: "jobTitle", label: "Job title" },
  { key: "department", label: "Department" },
  { key: "company", label: "Company" },
  { key: "office", label: "Office" },
  { key: "email", label: "Email" },
  { key: "telephone", label: "Telephone" },
  { key: "mobile", label: "Mobile" },
  { key: "website", label: "Website" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "x", label: "X" },
  { key: "photoUrl", label: "Photo URL" },
  { key: "custom1", label: "User defined 1" },
  { key: "custom2", label: "User defined 2" },
  { key: "custom3", label: "User defined 3" },
  { key: "custom4", label: "User defined 4" },
  { key: "custom5", label: "Accreditation" }
] as const;

export function fieldLabel(key: string): string {
  return DIRECTORY_FIELDS.find((f) => f.key === key)?.label ?? key;
}
