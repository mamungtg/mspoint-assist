// Built-in knowledge for the live demo bot on the landing page (bot id "demo").
// The demo answers questions about MSPoint Assist itself, so visitors and reviewers
// can try the product without signing up. Leads captured here go to MSPoint LLC.

export const DEMO_BOT = {
  id: "demo",
  name: "MSPoint Assist",
  site_url: "https://app.mspointbd.com",
  greeting: "Hi! I'm the MSPoint Assist demo. Ask me how the assistant works, what it costs, or how to add it to your website.",
};

export const DEMO_KNOWLEDGE = `
MSPoint Assist is an AI support assistant for small business websites, built by MSPoint LLC (a US company, Wyoming LLC) and founded by Mominul Hoque.
How it works: a business owner enters their website address. MSPoint Assist reads the public pages of the site (up to 12 pages on the free beta), splits the content into passages, and stores them as embeddings in a vector index. When a visitor asks a question in the chat widget, the assistant finds the most relevant passages and writes a short answer based only on that website's content, so it does not make up prices or policies.
Lead capture: when the assistant cannot answer, or when a visitor wants a quote or a call, the widget asks for name, mail address, phone (optional) and a message. Leads are stored and shown in the owner dashboard, where they can be exported as CSV.
Installation: after creating an assistant the owner gets one line of code, a script tag, to paste before the closing body tag of the website. It works on WordPress, Wix, Webflow, Shopify, Squarespace and plain HTML sites. No plugin is required.
Languages: the assistant replies in the language the visitor writes in.
Pricing during beta: Free plan includes 1 assistant, up to 12 indexed pages and 100 messages per day. Planned paid plans: Starter at 19 US dollars per month (3 assistants, 50 pages each, 2,000 messages per month, mail alerts for new leads) and Pro at 49 US dollars per month (10 assistants, 200 pages each, 10,000 messages per month, custom branding and priority support). Paid plans are not yet open; join by creating a free assistant.
Data and privacy: only public website pages are read. Visitor chat messages are not used to train AI models. Owners can re-index their site at any time and can delete their assistant and all its data from the dashboard.
Technology: MSPoint Assist runs entirely on Cloudflare's global network using Cloudflare Workers, Workers AI for embeddings and answers, Vectorize for search, and D1 for data, so it is fast worldwide.
Support and contact: mail support@mspointbd.com. The company website is mspointbd.com.
Getting started: scroll to "Create your assistant" on this page, enter your business name, website and mail address, and you will get your assistant ID, owner key and install code in about a minute.
`;
