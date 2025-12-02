import React from 'react';
import { createRoot } from 'react-dom/client';
import Compose from '../screens/Compose';

let activeHost = null;
let activeRoot = null;

function mountCompose() {
	// avoid multiple mounts
	if (activeHost) return;

	activeHost = document.createElement('div');
	activeHost.className = 'compose-host';
	document.body.appendChild(activeHost);

	// add body class so UI (floating button) can hide while composer is open
	document.body.classList.add('compose-open');

	// create a top-level root and render Compose directly into it.
	activeRoot = createRoot(activeHost);

	const cleanup = () => {
		try { activeRoot.unmount(); } catch (e) {}
		if (activeHost && activeHost.parentNode) activeHost.parentNode.removeChild(activeHost);
		activeHost = null;
		activeRoot = null;
		// remove body class on cleanup
		document.body.classList.remove('compose-open');
	};

	activeRoot.render(
		<Compose
			noPortal={true}      // render markup directly into this host (avoid nested portal)
			onCancel={() => cleanup()}
			onSent={() => cleanup()}
		/>
	);
}

export default function FloatingCompose({ onClick }) {
	// keep markup the same but override click to mount top-level composer.
	return (
		<button
			className="floating-compose"
			title="Compose"
			onClick={(e) => {
				// prevent accidental navigation/propagation
				try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
				mountCompose();
			}}
			aria-label="Compose"
		>
			<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
				<path d="M3 21v-3l12-12 3 3L6 21H3z" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
				<path d="M14 7l3 3" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
			</svg>
		</button>
	);
}
