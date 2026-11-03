"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAppointmentHistoryPage, getAppointmentsView, type PatientAppointment } from "@/lib/profile-api";

type HistorySection = "past" | "cancelled";
type SectionState = { hasMore: boolean; nextOffset: number; loading: boolean; error: string | null };
type HistoryState = Record<HistorySection, SectionState>;

const emptyHistoryState: HistoryState = {
  past: { hasMore: false, nextOffset: 0, loading: false, error: null },
  cancelled: { hasMore: false, nextOffset: 0, loading: false, error: null },
};

function mergeUnique(current: PatientAppointment[], incoming: PatientAppointment[]) {
  const seen = new Set(current.map((appointment) => appointment.id));
  return [...current, ...incoming.filter((appointment) => !seen.has(appointment.id))];
}

export function useAppointmentHistory() {
  const { getToken } = useAuth();
  const [appointments, setAppointments] = useState<PatientAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryState>(emptyHistoryState);
  const [retryKey, setRetryKey] = useState(0);
  const loadingSections = useRef(new Set<HistorySection>());

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const token = await getToken();
        if (!token) throw new Error("Your session could not be verified. Please try again.");
        const [upcoming, past, cancelled] = await Promise.all([
          getAppointmentsView(token, "upcoming"),
          getAppointmentHistoryPage(token, "past", 0),
          getAppointmentHistoryPage(token, "cancelled", 0),
        ]);
        if (!active) return;
        setAppointments(mergeUnique(upcoming, [...past.items, ...cancelled.items]));
        setHistory({
          past: { hasMore: past.has_more, nextOffset: past.next_offset, loading: false, error: null },
          cancelled: { hasMore: cancelled.has_more, nextOffset: cancelled.next_offset, loading: false, error: null },
        });
        setError(null);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "We couldn't load your appointments.");
      } finally {
        if (active) setLoading(false);
      }
    }
    setLoading(true);
    setError(null);
    void load();
    return () => { active = false; };
  }, [getToken, retryKey]);

  const retry = useCallback(() => {
    setAppointments([]);
    setHistory(emptyHistoryState);
    setLoading(true);
    setError(null);
    setRetryKey((key) => key + 1);
  }, []);

  const loadMore = useCallback(async (section: HistorySection) => {
    const current = history[section];
    if (!current.hasMore || loadingSections.current.has(section)) return;
    loadingSections.current.add(section);
    setHistory((state) => ({ ...state, [section]: { ...state[section], loading: true, error: null } }));
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const page = await getAppointmentHistoryPage(token, section, current.nextOffset);
      setAppointments((items) => mergeUnique(items, page.items));
      setHistory((state) => ({ ...state, [section]: { hasMore: page.has_more, nextOffset: page.next_offset, loading: false, error: null } }));
    } catch (cause) {
      setHistory((state) => ({ ...state, [section]: { ...state[section], loading: false, error: cause instanceof Error ? cause.message : "We couldn't load more appointments." } }));
    } finally {
      loadingSections.current.delete(section);
    }
  }, [getToken, history]);

  return { appointments, setAppointments, loading, error, history, retry, loadMore };
}
