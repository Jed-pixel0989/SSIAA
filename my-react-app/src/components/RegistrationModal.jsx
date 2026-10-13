import { useEffect, useRef, useState } from 'react'
import L from '../services/leaflet'
import api from '../services/api'
import { CheckCircle2, ShieldCheck, Mail, RefreshCw, KeyRound } from 'lucide-react'

const TAMPAKAN_CENTER = [6.443, 124.932]
const TAMPAKAN_BOUNDS = L.latLngBounds([6.30, 124.80], [6.58, 125.08])
const REGISTRATION_DRAFT_KEY = 'lambawasa_registration_draft'
const REGISTRATION_MAP_LAYERS = {
  roadmap: {
    label: 'Roadmap',
    url: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
    attribution: 'Map data &copy; Google Maps',
  },
  satellite: {
    label: 'Satellite Hybrid',
    url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
    attribution: 'Imagery &copy; Google Maps',
  },
  terrain: {
    label: 'Terrain',
    url: 'https://mt1.google.com/vt/lyrs=p&x={x}&y={y}&z={z}',
    attribution: 'Map data &copy; Google Maps',
  },
}

const registrationPinIcon = L.divIcon({
  className: 'registration-location-marker',
  html: '<span class="registration-location-marker-dot">●</span>',
  iconSize: [34, 42],
  iconAnchor: [17, 42],
  popupAnchor: [0, -38],
})

function isPointInsidePolygon(point, polygon) {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [currentLat, currentLng] = polygon[index]
    const [previousLat, previousLng] = polygon[previous]
    const intersects = ((currentLng > point.lng) !== (previousLng > point.lng))
      && (point.lat < ((previousLat - currentLat) * (point.lng - currentLng)) / (previousLng - currentLng) + currentLat)
    if (intersects) inside = !inside
  }
  return inside
}

export default function RegistrationModal({ isOpen, onClose, onRegistered, serviceBoundary, clusterBoundaries = [] }) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [mobile, setMobile] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [address, setAddress] = useState('')
  const [serviceCoordinates, setServiceCoordinates] = useState(null)
  const [selectedCluster, setSelectedCluster] = useState('')
  const [isResolvingAddress, setIsResolvingAddress] = useState(false)
  const [classification, setClassification] = useState('Residential')
  const [baseMapType, setBaseMapType] = useState('roadmap')
  const [error, setError] = useState('')

  // Google Account OTP Verification States
  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState('')
  const [isOtpVerified, setIsOtpVerified] = useState(false)
  const [verifiedEmail, setVerifiedEmail] = useState('')
  const [isSendingOtp, setIsSendingOtp] = useState(false)
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false)
  const [otpStatusMsg, setOtpStatusMsg] = useState('')
  const mapContainerRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const tileLayerRef = useRef(null)
  const addressMarkerRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return
    try {
      const savedDraft = JSON.parse(window.sessionStorage.getItem(REGISTRATION_DRAFT_KEY) || 'null')
      if (!savedDraft) return
      setAddress(savedDraft.address || '')
      setServiceCoordinates(savedDraft.serviceCoordinates || null)
      setSelectedCluster(savedDraft.selectedCluster || '')
      setBaseMapType(savedDraft.baseMapType || 'roadmap')
    } catch {
      window.sessionStorage.removeItem(REGISTRATION_DRAFT_KEY)
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    window.sessionStorage.setItem(REGISTRATION_DRAFT_KEY, JSON.stringify({
      address,
      serviceCoordinates,
      selectedCluster,
      baseMapType,
    }))
  }, [isOpen, address, serviceCoordinates, selectedCluster, baseMapType])

  useEffect(() => {
    if (!isOpen || !mapContainerRef.current || mapInstanceRef.current) return

    const boundaryPoints = serviceBoundary?.coordinates || []
    const registrationBounds = boundaryPoints.length >= 3
      ? L.latLngBounds(boundaryPoints)
      : TAMPAKAN_BOUNDS
    const registrationCenter = registrationBounds.getCenter()

    const map = L.map(mapContainerRef.current, {
      center: [registrationCenter.lat, registrationCenter.lng] || TAMPAKAN_CENTER,
      zoom: 13,
      zoomControl: true,
      attributionControl: true,
      maxBounds: registrationBounds,
      maxBoundsViscosity: 1,
    })

    const layerConfig = REGISTRATION_MAP_LAYERS[baseMapType]
    const tileLayer = L.tileLayer(layerConfig.url, {
      maxZoom: 20,
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
      attribution: layerConfig.attribution,
    }).addTo(map)
    tileLayerRef.current = tileLayer

    if (boundaryPoints.length >= 3) {
      L.polygon(boundaryPoints, {
        color: '#dc2626',
        weight: 2,
        dashArray: '7 5',
        fillColor: '#ef4444',
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(map)
      map.fitBounds(registrationBounds, { padding: [18, 18] })
    }

    clusterBoundaries.forEach((cluster) => {
      const coordinates = cluster.coordinates || []
      if (coordinates.length < 3) return
      L.polygon(coordinates, {
        color: '#2563eb',
        weight: 2,
        dashArray: '5 4',
        fillColor: '#60a5fa',
        fillOpacity: 0.2,
        interactive: false,
      }).bindTooltip(`${cluster.name} cluster`, { sticky: true }).addTo(map)
    })

    map.on('click', async (event) => {
      const { lat, lng } = event.latlng
      const isAllowedLocation = boundaryPoints.length >= 3
        ? isPointInsidePolygon({ lat, lng }, boundaryPoints)
        : TAMPAKAN_BOUNDS.contains([lat, lng])
      if (!isAllowedLocation) {
        setError('Service locations must be inside the President-approved boundary.')
        return
      }

      const cluster = clusterBoundaries.find((item) => (
        Array.isArray(item.coordinates)
        && item.coordinates.length >= 3
        && isPointInsidePolygon({ lat, lng }, item.coordinates)
      ))
      setSelectedCluster(cluster?.name || '')

      setServiceCoordinates({ lat, lng })
      setIsResolvingAddress(true)

      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18`,
          { headers: { Accept: 'application/json' } }
        )
        if (!response.ok) throw new Error('Address lookup failed')
        const result = await response.json()
        setAddress(result.display_name || `${lat.toFixed(6)}, ${lng.toFixed(6)}`)
      } catch {
        setAddress(`${lat.toFixed(6)}, ${lng.toFixed(6)}`)
      } finally {
        setIsResolvingAddress(false)
      }
    })

    mapInstanceRef.current = map
    window.setTimeout(() => map.invalidateSize(), 0)

    return () => {
      map.remove()
      mapInstanceRef.current = null
      addressMarkerRef.current = null
    }
  }, [isOpen])

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return
    if (addressMarkerRef.current) {
      map.removeLayer(addressMarkerRef.current)
      addressMarkerRef.current = null
    }
    if (!serviceCoordinates) return
    addressMarkerRef.current = L.marker([serviceCoordinates.lat, serviceCoordinates.lng], { icon: registrationPinIcon })
      .bindPopup('Selected service location')
      .addTo(map)
  }, [serviceCoordinates])

  useEffect(() => {
    if (!mapInstanceRef.current || !tileLayerRef.current) return
    const layerConfig = REGISTRATION_MAP_LAYERS[baseMapType]
    mapInstanceRef.current.removeLayer(tileLayerRef.current)
    tileLayerRef.current = L.tileLayer(layerConfig.url, {
      maxZoom: 20,
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
      attribution: layerConfig.attribution,
    }).addTo(mapInstanceRef.current)
  }, [baseMapType])

  if (!isOpen) return null

  const resetForm = () => {
    setFullName('')
    setEmail('')
    setMobile('')
    setUsername('')
    setPassword('')
    setConfirmPassword('')
    setAddress('')
    setServiceCoordinates(null)
    setSelectedCluster('')
    setIsResolvingAddress(false)
    setClassification('Residential')
    setBaseMapType('roadmap')
    setError('')
    setOtpSent(false)
    setOtpCode('')
    setIsOtpVerified(false)
    setVerifiedEmail('')
    setOtpStatusMsg('')
    setDevOtpHint('')
    window.sessionStorage.removeItem(REGISTRATION_DRAFT_KEY)
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  // Handle Send OTP
  const handleSendOtp = async () => {
    const cleanEmail = email.trim().toLowerCase()
    if (!cleanEmail) {
      setError('Please enter your Google account email first.')
      return
    }

    // Google account domain validation
    const domain = cleanEmail.split('@')[1] || ''
    const isGoogleAccount = domain === 'gmail.com' || domain === 'googlemail.com'
    if (!isGoogleAccount) {
      setError('A valid Google account (@gmail.com) is required to register.')
      return
    }

    setError('')
    setIsSendingOtp(true)
    setOtpStatusMsg('Sending verification code to your Google account...')

    try {
      const res = await api.sendGoogleOtp(cleanEmail)
      if (!res?.success) {
        setError(res?.error || 'Failed to dispatch verification code.')
        setOtpStatusMsg('')
        setIsSendingOtp(false)
        return
      }

      setOtpSent(true)
      setIsOtpVerified(false)
      setOtpStatusMsg(`A 6-digit verification OTP has been sent to ${cleanEmail}. Please check your Gmail inbox.`)
    } catch (err) {
      setError('Connection error while sending OTP. Please try again.')
      setOtpStatusMsg('')
    } finally {
      setIsSendingOtp(false)
    }
  }

  // Handle Verify OTP
  const handleVerifyOtp = async () => {
    const cleanEmail = email.trim().toLowerCase()
    const cleanCode = otpCode.trim()

    if (!cleanCode || cleanCode.length < 6) {
      setError('Please enter the 6-digit verification code sent to your Google account.')
      return
    }

    setError('')
    setIsVerifyingOtp(true)

    try {
      const res = await api.verifyGoogleOtp(cleanEmail, cleanCode)
      if (!res?.success) {
        setError(res?.error || 'Invalid or expired verification code.')
        setIsVerifyingOtp(false)
        return
      }

      setIsOtpVerified(true)
      setVerifiedEmail(cleanEmail)
      setOtpStatusMsg('✓ Google account verified successfully!')
      setDevOtpHint('')
    } catch (err) {
      setError('Failed to verify OTP code. Please check and try again.')
    } finally {
      setIsVerifyingOtp(false)
    }
  }

  const handleSubmit = (e) => {
    e.preventDefault()

    const cleanEmail = email.trim().toLowerCase()
    const domain = cleanEmail.split('@')[1] || ''
    if (domain !== 'gmail.com' && domain !== 'googlemail.com') {
      setError('You must use a valid Google account (@gmail.com) to create a consumer account.')
      return
    }

    if (!isOtpVerified || verifiedEmail !== cleanEmail) {
      setError('Please verify your Google account using the 6-digit OTP code before proceeding.')
      return
    }

    if (password.length < 8) {
      setError('Use at least 8 characters for your password.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match. Please check both fields.')
      return
    }
    if (!serviceCoordinates) {
      setError('Select the household service location on the map.')
      return
    }
    if (!selectedCluster) {
      setError('Select a service cluster by placing the pin inside an approved cluster boundary.')
      return
    }

    onRegistered({
      fullName: fullName.trim(),
      email: cleanEmail,
      mobile: mobile.trim(),
      username: username.trim().toLowerCase(),
      password,
      zone: selectedCluster,
      cluster: selectedCluster,
      address: address.trim(),
      serviceCoordinates,
      classification,
      role: 'House Hold',
      googleVerified: true,
      createdAt: new Date().toISOString(),
    })
    resetForm()
  }

  return (
    <div className="modal-backdrop" onClick={handleClose}>
      <div className="registration-modal-box" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={handleClose} aria-label="Close registration dialog">×</button>

        <div className="registration-header">
          <div className="registration-icon">✦</div>
          <div>
            <span className="registration-kicker">NEW HOUSEHOLD ACCOUNT</span>
            <h2>Create your Lambawasa account</h2>
            <p>Set up your verified household account with online bill tracking and problem reporting access.</p>
          </div>
        </div>

        {error && <div className="login-error-banner" role="alert">⚠️ {error}</div>}

        <form onSubmit={handleSubmit} className="registration-form">
          <div className="registration-form-grid">
            <label>
              Full name
              <input type="text" required placeholder="e.g. David Morales" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </label>
            <label className="registration-address-field">
              Service Address <span className="map-field-hint">Click the map to place the service pin</span>
              <div className="registration-map-wrapper">
                <div className="registration-map-layers" role="group" aria-label="Map layer">
                  {Object.entries(REGISTRATION_MAP_LAYERS).map(([key, layer]) => (
                    <button
                      key={key}
                      type="button"
                      className={baseMapType === key ? 'active' : ''}
                      onClick={() => setBaseMapType(key)}
                    >
                      {layer.label}
                    </button>
                  ))}
                </div>
                <div ref={mapContainerRef} className="registration-map" />
                {!serviceCoordinates && <div className="registration-map-empty">📍 Select the household location</div>}
              </div>
              <input
                type="text"
                required
                readOnly
                placeholder="Choose a location on the map"
                value={isResolvingAddress ? 'Resolving address...' : address}
                aria-describedby="registration-address-status"
              />
              <small id="registration-address-status" className="registration-address-status">
                {serviceCoordinates
                  ? `${serviceCoordinates.lat.toFixed(5)}, ${serviceCoordinates.lng.toFixed(5)}${selectedCluster ? ` · ${selectedCluster}` : ' · No cluster selected'}`
                  : 'Your selected map location will be used as the service address.'}
              </small>
            </label>
            <label>
              Account Type
              <select value={classification} onChange={(e) => setClassification(e.target.value)}>
                <option value="Residential">Residential (Household)</option>
                <option value="Commercial">Commercial</option>
              </select>
            </label>
            <div className="registration-google-auth-box">
              <div className="flex-between" style={{ marginBottom: '6px' }}>
                <label style={{ margin: 0, fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
                    <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.8-2.4 3.65v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.14z"/>
                    <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.24v3.15C3.26 21.36 7.33 24 12 24z"/>
                    <path fill="#FBBC05" d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.24C.45 8.15 0 9.97 0 12s.45 3.85 1.24 5.42l4.04-3.15z"/>
                    <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.24 6.58l4.04 3.15c.95-2.83 3.6-4.98 6.72-4.98z"/>
                  </svg>
                  Google Account (Email) *
                </label>
                {isOtpVerified && (
                  <span className="pill pill-green" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '3px 8px' }}>
                    <CheckCircle2 size={13} /> Verified Google Account
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="email"
                  required
                  placeholder="consumer@gmail.com"
                  value={email}
                  disabled={isOtpVerified}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    if (isOtpVerified) {
                      setIsOtpVerified(false)
                      setOtpSent(false)
                      setVerifiedEmail('')
                      setOtpStatusMsg('')
                    }
                  }}
                  style={{
                    flex: 1,
                    borderColor: isOtpVerified ? '#10b981' : undefined,
                    background: isOtpVerified ? '#f0fdf4' : undefined,
                  }}
                />
                {!isOtpVerified && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleSendOtp}
                    disabled={isSendingOtp || !email.trim()}
                    style={{
                      whiteSpace: 'nowrap',
                      padding: '10px 14px',
                      fontSize: '12px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                    }}
                  >
                    {isSendingOtp ? (
                      <>
                        <RefreshCw size={13} className="animate-spin" /> Sending...
                      </>
                    ) : otpSent ? (
                      <>
                        <RefreshCw size={13} /> Resend OTP
                      </>
                    ) : (
                      <>
                        <KeyRound size={13} /> Send Google OTP
                      </>
                    )}
                  </button>
                )}
              </div>
              <small className="muted" style={{ display: 'block', marginTop: '4px', fontSize: '11px' }}>
                Must be an active, valid Google Account (@gmail.com). A 6-digit OTP will be dispatched to verify ownership.
              </small>

              {/* OTP Input Row */}
              {otpSent && !isOtpVerified && (
                <div
                  style={{
                    marginTop: '12px',
                    padding: '12px 14px',
                    background: '#f8fafc',
                    borderRadius: '12px',
                    border: '1.5px dashed #0284c7',
                  }}
                >
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#0369a1', marginBottom: '6px' }}>
                    Enter 6-Digit Google OTP Code:
                  </label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="text"
                      maxLength={6}
                      placeholder="000000"
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      style={{
                        flex: 1,
                        fontSize: '18px',
                        fontWeight: '800',
                        letterSpacing: '4px',
                        textAlign: 'center',
                        fontFamily: 'monospace',
                        background: '#ffffff',
                        border: '1.5px solid #0284c7',
                        borderRadius: '8px',
                        padding: '8px 12px',
                      }}
                    />
                    <button
                      type="button"
                      className="primary-button"
                      onClick={handleVerifyOtp}
                      disabled={isVerifyingOtp || otpCode.length < 6}
                      style={{
                        padding: '8px 16px',
                        fontSize: '13px',
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {isVerifyingOtp ? 'Verifying...' : 'Verify OTP ✓'}
                    </button>
                  </div>

                  {otpStatusMsg && (
                    <div style={{ marginTop: '8px', fontSize: '11px', color: '#0284c7', fontWeight: 500 }}>
                      ℹ️ {otpStatusMsg}
                    </div>
                  )}
                </div>
              )}

              {isOtpVerified && (
                <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px', color: '#059669', fontSize: '12px', fontWeight: 600 }}>
                  <ShieldCheck size={16} /> Google Account <strong>{verifiedEmail}</strong> successfully authenticated!
                </div>
              )}
            </div>
            <label>
              Mobile number
              <input type="tel" required placeholder="+63 917 000 0000" value={mobile} onChange={(e) => setMobile(e.target.value)} />
            </label>
            <label>
              Account username
              <input type="text" required minLength="4" placeholder="Choose a username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label>
              Create password
              <input type="password" required minLength="8" placeholder="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label>
              Confirm password
              <input type="password" required minLength="8" placeholder="Re-enter your password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            </label>
          </div>

          <label className="registration-consent">
            <input type="checkbox" required />
            <span>I agree to receive Lambawasa billing and service updates.</span>
          </label>

          <button
            type="submit"
            className="primary-button full btn-lg"
            style={{
              background: !isOtpVerified ? '#94a3b8' : undefined,
              cursor: !isOtpVerified ? 'not-allowed' : undefined,
            }}
          >
            {isOtpVerified ? 'Create household account →' : 'Verify Google Account OTP to Register →'}
          </button>
        </form>

        <p className="registration-footer">Already registered? Close this window and sign in with your account.</p>
      </div>
    </div>
  )
}