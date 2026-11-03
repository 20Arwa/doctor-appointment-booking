"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getCurrentProfile } from "@/lib/profile-api";
import { resolveHomepageRole, type HomepageProfileResolution, type HomepageRole } from "@/lib/homepage-role";

const HomepageRoleContext = createContext<HomepageRole>("loading");

export function HomepageRoleProvider({ children }: { children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const [profile, setProfile] = useState<HomepageProfileResolution>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user?.id) return;
    let active = true;
    void getToken()
      .then((token) => token ? getCurrentProfile(token) : null)
      .then((currentProfile) => {
        if (active) setProfile({ userId: user.id, role: currentProfile?.role ?? null });
      })
      .catch(() => {
        if (active) setProfile({ userId: user.id, role: null });
      });
    return () => { active = false; };
  }, [getToken, isLoaded, isSignedIn, user?.id]);

  const role = resolveHomepageRole(isLoaded, Boolean(isSignedIn), user?.id, profile);
  return <HomepageRoleContext.Provider value={role}>{children}</HomepageRoleContext.Provider>;
}

export function useHomepageRole() {
  return useContext(HomepageRoleContext);
}
