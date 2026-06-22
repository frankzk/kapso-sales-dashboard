import { redirect } from "next/navigation";

// The marketing/root path simply forwards to the dashboard. The dashboard
// layout is responsible for bouncing unauthenticated users to /login.
export default function Home() {
  redirect("/dashboard");
}
