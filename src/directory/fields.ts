export const DIRECTORY_FIELDS = [
  { key: "displayName", label: "Display name", section: "personal", directory: true },
  { key: "givenName", label: "First name", section: "personal", directory: true },
  { key: "surname", label: "Last name", section: "personal", directory: true },
  { key: "pronouns", label: "Pronouns", section: "personal", directory: false },
  { key: "jobTitle", label: "Job title", section: "personal", directory: true },
  { key: "department", label: "Department", section: "personal", directory: true },
  { key: "company", label: "Company", section: "personal", directory: true },
  { key: "office", label: "Office", section: "address", directory: true },
  { key: "streetAddress", label: "Street", section: "address", directory: true },
  { key: "city", label: "City", section: "address", directory: true },
  { key: "state", label: "State / region", section: "address", directory: true },
  { key: "postalCode", label: "Postal code", section: "address", directory: true },
  { key: "country", label: "Country", section: "address", directory: true },
  { key: "email", label: "Email", section: "contact", directory: true },
  { key: "telephone", label: "Telephone", section: "contact", directory: true },
  { key: "mobile", label: "Mobile", section: "contact", directory: true },
  { key: "fax", label: "Fax", section: "contact", directory: true },
  { key: "website", label: "Website", section: "contact", directory: false },
  { key: "workingHours", label: "Working hours", section: "contact", directory: false },
  { key: "linkedin", label: "LinkedIn", section: "social", directory: false },
  { key: "x", label: "X (Twitter)", section: "social", directory: false },
  { key: "facebook", label: "Facebook", section: "social", directory: false },
  { key: "instagram", label: "Instagram", section: "social", directory: false },
  { key: "custom1", label: "User defined 1", section: "custom", directory: false },
  { key: "custom2", label: "User defined 2", section: "custom", directory: false },
  { key: "custom3", label: "User defined 3", section: "custom", directory: false },
  { key: "custom4", label: "User defined 4", section: "custom", directory: false },
  { key: "custom5", label: "Accreditation", section: "custom", directory: false }
] as const;

export type FieldKey = (typeof DIRECTORY_FIELDS)[number]["key"];

export type DirectoryUser = {
  id: string;
  email: string;
  displayName: string;
  givenName: string;
  surname: string;
  jobTitle: string;
  department: string;
  company: string;
  office: string;
  streetAddress: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  telephone: string;
  mobile: string;
  fax: string;
  website: string;
  pronouns: string;
  workingHours: string;
  photoUrl: string;
  linkedin: string;
  x: string;
  facebook: string;
  instagram: string;
  custom1: string;
  custom2: string;
  custom3: string;
  custom4: string;
  custom5: string;
  source: "entra" | "google" | "manual" | "demo";
  directoryId: string;
  domain: string;
  enabled: number;
  groupIds: string[];
};

export const emptyUser = (email: string): DirectoryUser => ({
  id: "",
  email: email.toLowerCase(),
  displayName: email,
  givenName: "",
  surname: "",
  jobTitle: "",
  department: "",
  company: "",
  office: "",
  streetAddress: "",
  city: "",
  state: "",
  postalCode: "",
  country: "",
  telephone: "",
  mobile: "",
  fax: "",
  website: "",
  pronouns: "",
  workingHours: "",
  photoUrl: "",
  linkedin: "",
  x: "",
  facebook: "",
  instagram: "",
  custom1: "",
  custom2: "",
  custom3: "",
  custom4: "",
  custom5: "",
  source: "manual",
  directoryId: "",
  domain: email.includes("@") ? email.split("@")[1]!.toLowerCase() : "",
  enabled: 1,
  groupIds: []
});
