/**
 * Hermetic-suite setup. Jev is opt-in via TYPESAFE_API_KEY. A live key in the
 * agent's environment must not turn the hermetic suite into a real typesafe.ai call.
 */
delete process.env.TYPESAFE_API_KEY;
