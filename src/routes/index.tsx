import { createFileRoute } from "@tanstack/react-router";
import { ScrapstormApp } from "@/components/game/ScrapstormApp";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <ScrapstormApp />;
}
