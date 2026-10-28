import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware(
  async (auth, request) => {
    const path = request.nextUrl.pathname;
    const isPatientRoute = path === "/patient" || path.startsWith("/patient/");
    const isDoctorRoute = path === "/doctor" || path.startsWith("/doctor/");

    if (isPatientRoute || isDoctorRoute) await auth.protect();
  },
  { signInUrl: "/sign-in" },
);

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
