// Amarcco Leads & Marketing LLC — finance lead request.
//
// The purposes here are the substance of the compliance design, so they are written to be
// read by the visitor, not by a lawyer. Three deliberate choices:
//
//   1. Contact consent is a *separate, required* purpose from service delivery. TCPA and
//      analogous state rules require prior express consent for autodialled or prerecorded
//      calls and texts, and for live transfers to buyers. Bundling it into "providing the
//      service" is the failure regulators cite.
//   2. Sharing with other buyers (lead resale) is its own optional purpose, off by default
//      at the deployment level (ALLOW_LEAD_RESALE). It is not a side effect of doing business.
//   3. Advertising measurement is optional and can be declined without losing the service.
//
// Vertical values match what the client actually sells.

export const amarccoLead = {
  form_id: "amarcco-lead",
  version: 1,
  title: "Request a finance or legal specialist",
  path: "/",
  retention_days: 180,

  destinations: [
    { name: "amarcco-intake", kind: "webhook" },
    { name: "amarcco-crm", kind: "crm", purposes: ["service_delivery"] },
    { name: "meta-capi", kind: "meta" },
    { name: "google-ads", kind: "google" },
    { name: "lead-buyers", kind: "webhook", purposes: ["resale"] },
  ],

  purposes: [
    {
      key: "service_delivery",
      label: "Delivering your request to a specialist",
      description: "We pass your details to a licensed specialist in the product you asked " +
        "about, who will assess your enquiry. This is what the form is for.",
      basis: "contract",
      required: true,
    },
    {
      key: "contact_consent",
      label: "Being contacted by phone, SMS or email",
      description: "You agree that Amarcco and its partners may contact you about your " +
        "enquiry using a phone number or email address you provide, including calls or " +
        "texts made with automated technology. Consent is not a condition of any purchase, " +
        "message frequency varies, and you can opt out at any time.",
      basis: "consent",
      required: true,
    },
    {
      key: "advertising_measurement",
      label: "Measuring which advertisement worked",
      description: "We send a hashed (one-way scrambled) form of your email or phone to " +
        "Google or Meta so we can tell which advert produced your enquiry. Neither platform " +
        "receives your name, and this is never sold on.",
      basis: "consent",
      required: false,
    },
    {
      key: "resale",
      label: "Sharing your enquiry with other marketing partners",
      description: "Some people want to be contacted by more than one company. If you agree, " +
        "we may share your enquiry with other vetted marketing partners, and you may receive " +
        "contact from them. This is optional, and declining does not affect our service to you.",
      basis: "consent",
      required: false,
    },
  ],

  fields: [
    { name: "full_name", type: "text", label: "Full name", required: true, max_length: 120 },
    { name: "email", type: "email", label: "Email address", required: true, max_length: 254 },
    { name: "phone", type: "phone", label: "Phone number", required: true,
      help: "Include your country code, for example +1 for the United States." },
    { name: "vertical", type: "select", label: "What do you need help with?", required: true,
      options: ["Mortgage refinance", "New home purchase", "Reverse mortgage",
        "Credit card debt", "Tax debt", "Unsecured debt", "Legal enquiry",
        "Insurance enquiry"] },
    { name: "state", type: "text", label: "State (US)", required: false, max_length: 40,
      help: "Used to route your enquiry to a specialist licensed in your state." },
    { name: "amount", type: "number", label: "Approximate amount (USD)", required: false,
      help: "Optional. A range is fine — this only helps us route the enquiry." },
    { name: "notes", type: "longtext", label: "Anything else we should know", required: false,
      max_length: 1000 },
    { name: "consent_confirmed", type: "checkbox", label: "I am 18 or older and this is my " +
      "own contact information", required: true },
  ],
};

export default amarccoLead;
