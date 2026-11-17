/*
 * OwO Bot for Discord
 * Copyright (C) 2019 Christopher Thai
 * This software is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
 * For more information, see README.md and LICENSE
 */

/**
 * DNS lookup order for the gateway socket.
 *
 * Node >= 17 resolves with the operating system's order (`verbatim`, RFC 6724),
 * which prefers **AAAA/IPv6** records. `fetch`/undici (all REST traffic) hides a
 * broken IPv6 route with Happy Eyeballs, but the raw `net`/`tls` socket used by
 * `ws` — the gateway — does not: on a host with an unroutable IPv6 route it waits
 * for the TCP connect to time out (often minutes, sometimes silently) and Discord
 * never sees an IDENTIFY.
 *
 * Symptom this produces, exactly: REST succeeds (`[DISCORD] authentication
 * successful`), the worker is alive, no HELLO, no IDENTIFY, no READY, no proxy
 * error. `ipv4first` restores the pre-17 behaviour for this process only, and it
 * is what most panel hosts need. Set `GATEWAY_IPV4_FIRST=false` to keep the
 * system order (e.g. a host that is IPv6-only).
 */

const dns = require('dns');

function desiredOrder(env = process.env) {
	const raw = String(env.GATEWAY_IPV4_FIRST === undefined ? 'true' : env.GATEWAY_IPV4_FIRST)
		.trim()
		.toLowerCase();
	if (raw === 'false' || raw === 'no' || raw === '0' || raw === 'verbatim') return 'verbatim';
	if (raw === 'ipv6first') return 'ipv6first';
	return 'ipv4first';
}

/** Applies the lookup order; safe to call in every process (master and workers). */
function apply(env = process.env) {
	if (typeof dns.setDefaultResultOrder !== 'function') {
		return {
			applied: false,
			order: null,
			reason: 'dns.setDefaultResultOrder is unavailable (node < 17)',
		};
	}
	const order = desiredOrder(env);
	const previous =
		typeof dns.getDefaultResultOrder === 'function' ? dns.getDefaultResultOrder() : null;
	try {
		dns.setDefaultResultOrder(order);
		return { applied: order !== previous, order, previous };
	} catch (err) {
		return { applied: false, order: previous, reason: err.message };
	}
}

module.exports = { apply, desiredOrder };
