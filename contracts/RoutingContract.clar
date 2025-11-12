(define-constant ERR-NOT-FOUND u100)
(define-constant ERR-UNAUTHORIZED u101)
(define-constant ERR-ALERT-CLOSED u102)
(define-constant ERR-INVALID-LOCATION u103)
(define-constant ERR-NO-RESPONDERS u104)
(define-constant ERR-RESPONDER-NOT-VERIFIED u105)
(define-constant ERR-DISTANCE-CALC-FAIL u106)
(define-constant ERR-REGISTRY-NOT-SET u107)
(define-constant ERR-ALREADY-ROUTED u108)
(define-constant ERR-INVALID-RADIUS u109)
(define-constant ERR-MAX-ROUTING-ATTEMPTS u110)

(define-constant EARTH-RADIUS u6371000)
(define-constant PI u3141592653589793238)
(define-constant DEG-TO-RAD u1745329251994329577)
(define-constant MAX-ROUTING-ATTEMPTS u5)
(define-constant DEFAULT-SEARCH-RADIUS u50000)

(define-data-var registry-contract principal 'SP000000000000000000002Q6VF78)
(define-data-var verified-responders (list 1000 principal) (list ))

(define-map alerts-routing
  uint
  {
    alert-id: uint,
    routed-to: (optional principal),
    distance: uint,
    timestamp: uint,
    attempt-count: uint,
    search-radius: uint
  }
)

(define-map responder-locations
  principal
  {
    lat: int,
    long: int,
    verified: bool,
    last-updated: uint
  }
)

(define-read-only (get-alert-routing (alert-id uint))
  (map-get? alerts-routing alert-id)
)

(define-read-only (get-responder-location (responder principal))
  (map-get? responder-locations responder)
)

(define-read-only (haversine-distance (lat1 int) (long1 int) (lat2 int) (long2 int))
  (let (
    (dlat (/ (* (- lat2 lat1) DEG-TO-RAD) u1000000000))
    (dlong (/ (* (- long2 long1) DEG-TO-RAD) u1000000000))
    (lat1-rad (/ (* lat1 DEG-TO-RAD) u1000000000))
    (lat2-rad (/ (* lat2 DEG-TO-RAD) u1000000000))
    (a (+ 
         (* (sin (/ dlat u2)) (sin (/ dlat u2)))
         (* (* (cos lat1-rad) (cos lat2-rad)) (sin (/ dlong u2)) (sin (/ dlong u2)))
       ))
    (c (* u2 (atan2 (sqrt a) (sqrt (- u1 a)))))
  )
    (unwrap! (some (/ (* EARTH-RADIUS c) u1000)) (err ERR-DISTANCE-CALC-FAIL))
  )
)

(define-read-only (is-responder-verified (responder principal))
  (match (map-get? responder-locations responder)
    data (get verified data)
    false
  )
)

(define-read-only (get-verified-responders-in-radius (center-lat int) (center-long int) (radius uint))
  (filter 
    (lambda (responder principal)
      (let ((loc (unwrap! (map-get? responder-locations responder) false)))
        (<= (haversine-distance center-lat center-long (get lat loc) (get long loc)) radius)
      )
    )
    (var-get verified-responders)
  )
)

(define-private (find-nearest-verified (alert-lat int) (alert-long int) (responders (list 50 principal)) (current-best {responder: (optional principal), distance: uint}))
  (fold 
    (lambda (responder principal) (acc {responder: (optional principal), distance: uint}))
      (let (
        (loc (unwrap! (map-get? responder-locations responder) acc))
        (dist (haversine-distance alert-lat alert-long (get lat loc) (get long loc)))
      )
        (if (or 
              (is-none (get responder acc))
              (< dist (get distance acc))
            )
            {responder: (some responder), distance: dist}
            acc
        )
      )
    responders
    current-best
  )
)

(define-public (route-alert-to-nearest 
  (alert-id uint)
  (alert-lat int)
  (alert-long int)
  (initial-radius uint)
)
  (let (
    (existing (map-get? alerts-routing alert-id))
    (registry (var-get registry-contract))
    (attempt-count (default-to u0 (get attempt-count existing)))
    (search-radius (if (> initial-radius u0) initial-radius DEFAULT-SEARCH-RADIUS))
  )
    (asserts! (not (is-eq registry 'SP000000000000000000002Q6VF78)) (err ERR-REGISTRY-NOT-SET))
    (asserts! (is-none (get routed-to existing)) (err ERR-ALREADY-ROUTED))
    (asserts! (< attempt-count MAX-ROUTING-ATTEMPTS) (err ERR-MAX-ROUTING-ATTEMPTS))
    (asserts! (> search-radius u0) (err ERR-INVALID-RADIUS))
    (asserts! (and (>= alert-lat i-900000000) (<= alert-lat i900000000)) (err ERR-INVALID-LOCATION))
    (asserts! (and (>= alert-long i-1800000000) (<= alert-long i1800000000)) (err ERR-INVALID-LOCATION))

    (let (
      (responders-in-radius (get-verified-responders-in-radius alert-lat alert-long search-radius))
      (nearest (find-nearest-verified alert-lat alert-long responders-in-radius {responder: none, distance: u999999999}))
    )
      (if (is-some (get responder nearest))
        (begin
          (map-set alerts-routing alert-id
            {
              alert-id: alert-id,
              routed-to: (get responder nearest),
              distance: (get distance nearest),
              timestamp: block-height,
              attempt-count: u0,
              search-radius: search-radius
            }
          )
          (ok (unwrap-panic (get responder nearest)))
        )
        (begin
          (map-set alerts-routing alert-id
            {
              alert-id: alert-id,
              routed-to: none,
              distance: u0,
              timestamp: block-height,
              attempt-count: (+ attempt-count u1),
              search-radius: (* search-radius u2)
            }
          )
          (err ERR-NO-RESPONDERS)
        )
      )
    )
  )
)

(define-public (register-responder-location (lat int) (long int))
  (let ((sender tx-sender))
    (asserts! (and (>= lat i-900000000) (<= lat i900000000)) (err ERR-INVALID-LOCATION))
    (asserts! (and (>= long i-1800000000) (<= long i1800000000)) (err ERR-INVALID-LOCATION))
    (map-set responder-locations sender
      {
        lat: lat,
        long: long,
        verified: (default-to false (get verified (map-get? responder-locations sender))),
        last-updated: block-height
      }
    )
    (ok true)
  )
)

(define-public (verify-responder (responder principal))
  (let ((caller tx-sender))
    (asserts! (is-eq caller (var-get registry-contract)) (err ERR-UNAUTHORIZED))
    (match (map-get? responder-locations responder)
      data (begin
        (if (not (get verified data))
          (var-set verified-responders (append (var-get verified-responders) responder))
          true
        )
        (map-set responder-locations responder (merge data {verified: true}))
        (ok true)
      )
      (err ERR-NOT-FOUND)
    )
  )
)

(define-public (set-registry-contract (new-registry principal))
  (begin
    (asserts! (is-eq tx-sender (var-get registry-contract)) (err ERR-UNAUTHORIZED))
    (var-set registry-contract new-registry)
    (ok true)
  )
)

(define-public (reset-routing-for-alert (alert-id uint))
  (begin
    (asserts! (is-some (map-get? alerts-routing alert-id)) (err ERR-NOT-FOUND))
    (map-delete alerts-routing alert-id)
    (ok true)
  )
)