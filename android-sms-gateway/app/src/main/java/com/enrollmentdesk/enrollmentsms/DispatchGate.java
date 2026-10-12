package com.enrollmentdesk.enrollmentsms;

/** Shared by pause, timeout, callbacks and the final SMS invocation boundary. Never persisted. */
final class DispatchGate {
  static final Object LOCK = new Object();
  private static long generation;
  private static boolean active;

  static long start() {
    synchronized (LOCK) {
      if (!active) {
        generation++;
        active = true;
      }
      return generation;
    }
  }

  static void stop() {
    synchronized (LOCK) {
      active = false;
      generation++;
    }
  }

  static boolean running() {
    synchronized (LOCK) {
      return active;
    }
  }

  static boolean valid(long owner) {
    synchronized (LOCK) {
      return active && generation == owner;
    }
  }
}
