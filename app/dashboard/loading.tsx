import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";

// Generic dashboard skeleton — shown instantly on navigation while the server
// component fetches. Also the fallback for child routes without their own.
export default function Loading() {
  return <DashboardRouteSkeleton />;
}
