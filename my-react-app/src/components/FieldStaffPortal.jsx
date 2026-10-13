import { useEffect, useRef, useState } from 'react'
import {
  Compass,
  LogOut,
  Calculator,
  Gauge,
  Wrench,
  MapPin,
  Phone,
  Navigation,
  ExternalLink,
} from 'lucide-react'
import L from '../services/leaflet'
import 'leaflet/dist/leaflet.css'
import './FieldStaffPortal.css'

const FIELD_MAP_CENTER = [6.429763, 124.970325]

export default function FieldStaffPortal({
  currentUser,
  consumers = [],
  geoPins = [],
  clusterBoundaries = [],
  meters = [],
  complaints = [],
  pendingMeterReadings = [],
  initialTrackedTicketId = null,
  onNavigate,
  onSignOut,
}) {
  const fieldMapRef = useRef(null)
  const fieldMapInstanceRef = useRef(null)
  const routeLayerRef = useRef(null)
  const [staffLocation, setStaffLocation] = useState(null)
  const [locationStatus, setLocationStatus] = useState('Locating staff device...')
  const [trackedTicketId, setTrackedTicketId] = useState(initialTrackedTicketId)
  const open = (view) => onNavigate(view)
  const openTickets = complaints.filter((complaint) => complaint.status !== 'Resolved')
  const assignedTickets = openTickets.filter((complaint) => (
    complaint.assignedTech === currentUser.fullName
    || complaint.assignedTo === currentUser.fullName
    || complaint.status === 'Pending'
  ))
  const trackedTicket = assignedTickets.find((ticket) => ticket.id === trackedTicketId) || assignedTickets[0]
  const pendingReadings = pendingMeterReadings.filter((reading) => reading.status !== 'Confirmed')
  const consumerLocations = consumers
    .map((consumer) => {
      const pin = geoPins.find((item) => item.consumerId === consumer.id)
      const latitude = Number(pin?.lat ?? pin?.latitude)
      const longitude = Number(pin?.lng ?? pin?.longitude)
      const matchingCluster = clusterBoundaries.find((cluster) => {
        const points = cluster.coordinates || []
        if (points.length < 3 || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return false
        let inside = false
        for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
          const current = points[index]
          const prior = points[previous]
          const intersects = ((current[1] > longitude) !== (prior[1] > longitude))
            && (latitude < ((prior[0] - current[0]) * (longitude - current[1])) / (prior[1] - current[1]) + current[0])
          if (intersects) inside = !inside
        }
        return inside
      })
      return {
        ...consumer,
        zone: matchingCluster?.name || pin?.cluster || consumer.cluster || pin?.zone || consumer.zone,
        hasLocation: Boolean(pin?.lat || pin?.latitude || consumer.latitude || consumer.requestedLatitude),
      }
    })
    .sort((first, second) => (first.zone || '').localeCompare(second.zone || '') || first.name.localeCompare(second.name))

  useEffect(() => {
    if (!fieldMapRef.current || fieldMapInstanceRef.current) return undefined

    const map = L.map(fieldMapRef.current, {
      center: FIELD_MAP_CENTER,
      zoom: 13,
      zoomControl: true,
      attributionControl: true,
    })
    L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
      maxZoom: 20,
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
      attribution: 'Map data &copy; Google Maps',
    }).addTo(map)
    fieldMapInstanceRef.current = map
    routeLayerRef.current = L.layerGroup().addTo(map)

    return () => {
      map.remove()
      fieldMapInstanceRef.current = null
      routeLayerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationStatus('Live location unavailable on this device')
      return undefined
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setStaffLocation({ lat: position.coords.latitude, lng: position.coords.longitude })
        setLocationStatus('Live location active')
      },
      () => setLocationStatus('Allow location access to track the route'),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    )

    return () => navigator.geolocation.clearWatch(watchId)
  }, [])

  useEffect(() => {
    if (initialTrackedTicketId) setTrackedTicketId(initialTrackedTicketId)
  }, [initialTrackedTicketId])

  useEffect(() => {
    if (!trackedTicket) return
    setTrackedTicketId(trackedTicket.id)
  }, [trackedTicket?.id])

  useEffect(() => {
    const map = fieldMapInstanceRef.current
    if (!map) return

    map.eachLayer((layer) => {
      if (layer instanceof L.Marker) map.removeLayer(layer)
    })

    const visiblePins = geoPins.filter((pin) => Number.isFinite(Number(pin.lat ?? pin.latitude)) && Number.isFinite(Number(pin.lng ?? pin.longitude)))
    const bounds = []
    visiblePins.forEach((pin) => {
      const lat = Number(pin.lat ?? pin.latitude)
      const lng = Number(pin.lng ?? pin.longitude)
      bounds.push([lat, lng])
      const consumer = consumers.find((item) => item.id === pin.consumerId)
      const matchingCluster = clusterBoundaries.find((cluster) => {
        const points = cluster.coordinates || []
        if (points.length < 3) return false
        let inside = false
        for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
          const current = points[index]
          const prior = points[previous]
          const intersects = ((current[1] > lng) !== (prior[1] > lng))
            && (lat < ((prior[0] - current[0]) * (lng - current[1])) / (prior[1] - current[1]) + current[0])
          if (intersects) inside = !inside
        }
        return inside
      })
      L.marker([lat, lng])
        .bindPopup(`<strong>${pin.name || consumer?.name || 'Consumer'}</strong><br />${matchingCluster?.name || pin.cluster || consumer?.cluster || pin.zone || consumer?.zone || 'Unassigned zone'}<br />${consumer?.contact || 'No phone number'}`)
        .addTo(map)
    })

    if (bounds.length === 1) map.setView(bounds[0], 16)
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 })
    window.setTimeout(() => map.invalidateSize(), 0)
  }, [geoPins, consumers, clusterBoundaries])

  useEffect(() => {
    const map = fieldMapInstanceRef.current
    const routeLayer = routeLayerRef.current
    if (!map || !routeLayer) return

    routeLayer.clearLayers()
    if (!trackedTicket) return

    const targetPin = geoPins.find((pin) => (
      String(pin.consumerId) === String(trackedTicket.consumerId)
      || String(pin.accountNo) === String(trackedTicket.accountNo)
    ))
    const targetLat = Number(targetPin?.lat ?? targetPin?.latitude)
    const targetLng = Number(targetPin?.lng ?? targetPin?.longitude)
    if (!Number.isFinite(targetLat) || !Number.isFinite(targetLng)) return

    const staffPoint = staffLocation
      ? [staffLocation.lat, staffLocation.lng]
      : FIELD_MAP_CENTER
    const consumerPoint = [targetLat, targetLng]

    // Calculate approximate road driving distance
    const toRad = (x) => (x * Math.PI) / 180
    const dLat = toRad(targetLat - staffPoint[0])
    const dLng = toRad(targetLng - staffPoint[1])
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(staffPoint[0])) * Math.cos(toRad(targetLat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    const drivingKm = ((6371 * c) * 1.25).toFixed(1)
    const drivingMins = Math.max(3, Math.round((drivingKm / 35) * 60))

    // Staff current location circle
    L.circleMarker(staffPoint, {
      radius: 8,
      color: '#0284c7',
      fillColor: '#38bdf8',
      fillOpacity: 1,
      weight: 3,
    }).bindTooltip(staffLocation ? 'Your Live GPS Location' : 'Base Terminal Location', { direction: 'top' }).addTo(routeLayer)

    // Google Navigation Polyline casing + active path
    L.polyline([staffPoint, consumerPoint], {
      color: '#0369a1',
      weight: 7,
      opacity: 0.45,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(routeLayer)

    L.polyline([staffPoint, consumerPoint], {
      color: '#0284c7',
      weight: 4.5,
      opacity: 1,
      dashArray: '10 6',
      lineCap: 'round',
      lineJoin: 'round',
    }).bindTooltip(`🚙 Driving: ~${drivingKm} km (${drivingMins} mins via Google GPS)`, { sticky: true }).addTo(routeLayer)

    // Destination target pin with Google GPS action
    L.circleMarker(consumerPoint, {
      radius: 9,
      color: '#b91c1c',
      fillColor: '#ef4444',
      fillOpacity: 1,
      weight: 3,
    }).bindPopup(`
      <div style="font-family:sans-serif; padding:4px;">
        <strong style="color:#102033; font-size:13px;">${trackedTicket.consumerName || 'Reported Consumer'}</strong><br />
        <span style="color:#617286; font-size:11px;">${trackedTicket.issueType || 'Service report'}</span><br />
        <div style="margin-top:8px;">
          <a href="https://www.google.com/maps/dir/?api=1&destination=${targetLat},${targetLng}&origin=${staffPoint[0]},${staffPoint[1]}&travelmode=driving" 
             target="_blank" rel="noopener noreferrer" 
             style="display:inline-block; padding:6px 10px; background:#0284c7; color:#fff; text-decoration:none; border-radius:6px; font-size:11px; font-weight:700;">
            🚗 Start Google GPS Navigation
          </a>
        </div>
      </div>
    `).addTo(routeLayer)

    map.fitBounds([staffPoint, consumerPoint], { padding: [40, 40], maxZoom: 16 })
  }, [trackedTicket, staffLocation, geoPins])

  return (
    <main className="field-portal">
      <header className="field-portal-header">
        <div className="field-portal-brand">
          <div className="field-portal-mark" aria-hidden="true"><Compass size={18} strokeWidth={2.5} /></div>
          <div>
            <span>FIELD OPERATIONS</span>
            <strong>Lambawasa mobile desk</strong>
          </div>
        </div>
        <button type="button" className="field-portal-signout" onClick={onSignOut} aria-label="Sign out">
          <LogOut size={18} strokeWidth={2} />
        </button>
      </header>

      <section className="field-portal-welcome">
        <div>
          <span className="field-portal-eyebrow">ON DUTY · {currentUser.zone || 'ALL SECTORS'}</span>
          <h1>Good day, {currentUser.fullName.split(' ')[0]}.</h1>
          <p>Your field tools and assigned work, ready for the next stop.</p>
        </div>
        <div className="field-portal-status"><i /> Connected</div>
      </section>

      <section className="field-portal-priority" aria-label="Today's field summary">
        <div><strong>{assignedTickets.length}</strong><span>Assigned jobs</span></div>
        <div><strong>{pendingReadings.length}</strong><span>Readings to confirm</span></div>
        <div><strong>{meters.length}</strong><span>Tracked meters</span></div>
      </section>

      <section className="field-portal-actions" aria-labelledby="field-actions-title">
        <div className="field-portal-section-head"><h2 id="field-actions-title">Field tools</h2><span>QUICK ACCESS</span></div>
        <div className="field-portal-action-grid">
          <button type="button" onClick={() => open('Consumption Calculator')}><span className="field-action-icon blue"><Calculator size={18} /></span><strong>Read meter</strong><small>Calculate usage</small></button>
          <button type="button" onClick={() => open('Meter Assets')}><span className="field-action-icon teal"><Gauge size={18} /></span><strong>My meters</strong><small>Asset records</small></button>
          <button type="button" onClick={() => open('Service Desk')}><span className="field-action-icon amber"><Wrench size={18} /></span><strong>Service jobs</strong><small>Update tickets</small></button>
          <button type="button" onClick={() => open('Geographical Mapping')}><span className="field-action-icon slate"><MapPin size={18} /></span><strong>Field map</strong><small>Find locations</small></button>
        </div>
      </section>

      <section className="field-portal-consumers" aria-labelledby="field-consumers-title">
        <div className="field-portal-section-head">
          <h2 id="field-consumers-title">Consumer locations</h2>
          <span>{consumerLocations.length} HOUSEHOLDS</span>
        </div>
        {consumerLocations.length > 0 ? consumerLocations.map((consumer) => (
          <div className="field-consumer-row" key={consumer.id || consumer.accountNo}>
            <span className={`field-consumer-location ${consumer.hasLocation ? 'is-pinned' : ''}`} aria-label={consumer.hasLocation ? 'Pinned location' : 'No pinned location'}>
              <MapPin size={14} />
            </span>
            <div className="field-consumer-details">
              <strong>{consumer.name}</strong>
              <span>{consumer.zone || 'Unassigned zone'}</span>
            </div>
            <a className="field-consumer-phone" href={`tel:${consumer.contact || ''}`}>
              <Phone size={12} style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle' }} />
              {consumer.contact || 'No phone'}
            </a>
          </div>
        )) : (
          <div className="field-empty-state"><span><MapPin size={24} /></span><div><strong>No consumer locations yet</strong><p>Registered household pins will appear here.</p></div></div>
        )}
      </section>

      <section className="field-portal-map-section" aria-labelledby="field-map-title">
        <div className="field-portal-section-head">
          <h2 id="field-map-title">Pinned consumer locations</h2>
          <button type="button" onClick={() => open('Geographical Mapping')}>Open full map →</button>
        </div>
        <div ref={fieldMapRef} className="field-portal-map" aria-label="Map of pinned consumer locations" />
        {geoPins.length === 0 && <p className="field-map-empty">No consumer pins have been registered yet.</p>}
      </section>

      <section className="field-portal-work" aria-labelledby="field-work-title">
        <div className="field-portal-section-head"><h2 id="field-work-title">Today's queue</h2><button type="button" onClick={() => open('Service Desk')}>View all →</button></div>
        <div className="field-tracking-status" role="status">
          <span className="field-tracking-dot" /> {locationStatus}{trackedTicket ? ` · Tracking ${trackedTicket.consumerName || 'reported consumer'}` : ''}
        </div>
        {assignedTickets.length > 0 ? assignedTickets.slice(0, 3).map((ticket) => (
          <button type="button" className={`field-job-row ${trackedTicket?.id === ticket.id ? 'is-tracked' : ''}`} key={ticket.id} onClick={() => setTrackedTicketId(ticket.id)}>
            <span className="field-job-icon">⚒</span>
            <span><strong>{ticket.issueType || 'Service inspection'}</strong><small>{ticket.consumerName || 'Household'} · {ticket.zone || currentUser.zone || 'Assigned sector'}</small></span>
            <em>{trackedTicket?.id === ticket.id ? 'Tracking' : ticket.status}</em>
          </button>
        )) : (
          <div className="field-empty-state"><span>✓</span><div><strong>No open jobs assigned</strong><p>Your queue is clear for now.</p></div></div>
        )}
      </section>

    </main>
  )
}
