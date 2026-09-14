import { redirect } from "next/navigation";
import { courierRouteHref } from "@/lib/courier-navigation";

export default async function LegacyRoutesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(courierRouteHref(await searchParams));
}
