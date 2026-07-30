import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no",
      },
      {
        name: "description",
        content:
          "Scrapstorm League — arcade combat racing on ruined planets. Drift, draft, and fight with salvaged alien tech.",
      },
      { title: "Scrapstorm League" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <AuthProvider>
          <Outlet />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  );
}
