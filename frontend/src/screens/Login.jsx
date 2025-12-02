import React, { useState } from 'react';
import { login, setToken } from '../api';
import { FingerprintPattern, Container, Rabbit  } from 'lucide-react';



export default function Login({ onLogin }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [show, setShow] = useState(false);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    async function handleSubmit(e) {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const res = await login(email, password);
            if (res.token) {
                setToken(res.token);
                onLogin && onLogin();
            } else {
                setError(res.error || 'Login failed');
            }
        } catch (err) {
            setError(err.message || 'Login error');
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="login-page">
            <div className="login-wrapper">
                <div className="logo-box" aria-hidden="true">
                    {/* simple SVG logo */}
                    <Rabbit size={60} />
                </div>

                <h1 className="login-title">Secure Sign In</h1>
                <p className="login-subtitle">Access your internal company mail</p>

                <form className="login-card" onSubmit={handleSubmit}>
                    <label className="field-label">Username</label>
                    <input
                        className="field-input"
                        placeholder="Enter your username"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        autoComplete="username"
                    />

                    <label className="field-label">Password</label>
                    <div className="password-row">
                        <input
                            className="field-input"
                            type={show ? 'text' : 'password'}
                            placeholder="Enter your password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            autoComplete="current-password"
                        />
                        <button
                            type="button"
                            className="eye-btn"
                            onClick={() => setShow(s => !s)}
                            aria-label={show ? 'Hide password' : 'Show password'}
                        >
                            {/* eye / eye-off SVGs */}
                            {show ? (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <path d="M3 3l18 18" stroke="#9aa6b2" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                                    <path d="M10.58 10.58A3 3 0 0013.42 13.42" stroke="#9aa6b2" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                                    <path d="M2.5 12C4.7 7 9 4 12 4c1.6 0 3.1.6 4.6 1.6" stroke="#9aa6b2" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                                    <path d="M21.5 12c-2.2 5-6.5 8-9.5 8-1.6 0-3.1-.6-4.6-1.6" stroke="#9aa6b2" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            ) : (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <path d="M2.5 12C4.7 7 9 4 12 4c3 0 6.3 3 9.5 8-2.2 5-6.5 8-9.5 8-3 0-6.3-3-9.5-8z" stroke="#9aa6b2" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                                    <circle cx="12" cy="12" r="3" stroke="#9aa6b2" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            )}
                        </button>
                    </div>

                    <div className="forgot-row">
                        <a className="forgot-link" href="#" onClick={e => e.preventDefault()}>Forgot Password?</a>
                    </div>

                    {error && <div className="error-text">{error}</div>}

                    <button className="primary-btn" type="submit" disabled={loading}>
                        {loading ? 'Signing in...' : 'Sign In'}
                    </button>

                    <div className="or-row"><span className="line" /> <span>OR</span> <span className="line" /></div>

                    <button type="button" className="biometric-btn" aria-label="Sign in with biometrics">
                        <FingerprintPattern size={25} style={{ marginRight: 8 }} />Sign in with Biometrics
                    </button>

                    <p className="terms">By signing in, you agree to our <a href="#">Terms of Service</a>.</p>
                </form>
            </div>
        </div>
    );
}
