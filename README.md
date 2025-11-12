# Decentralized Emergency Response Network (DERN)

## Overview

The Decentralized Emergency Response Network (DERN) is a Web3 project built on the Stacks blockchain using Clarity smart contracts. It addresses real-world problems in emergency response systems, such as centralized failures during disasters, lack of transparency in alert routing, inefficient responder allocation, and integration challenges with national infrastructure like power grids or emergency services.

### Problem Solved
In real-world scenarios, emergencies (e.g., natural disasters, power outages, medical crises) often overwhelm centralized systems. DERN uses blockchain to:
- Route alerts automatically to the nearest verified responders based on geolocation.
- Integrate with national grids (e.g., via oracles for power grid status or public APIs for emergency data).
- Ensure transparency, immutability, and incentives for responders through token rewards.
- Reduce response times in underserved areas, prevent fraud in responder verification, and provide audit trails for accountability.

This is particularly useful in regions prone to hurricanes, earthquakes, or grid failures, where decentralized tech can bypass single points of failure.

### Key Features
- **Alert Routing**: Smart contracts use location data to match alerts with nearby verified responders.
- **Verifier System**: Decentralized verification of responders (e.g., certifications stored on-chain).
- **Integration with National Grids**: Oracles feed real-time data (e.g., grid outages) to trigger alerts.
- **Incentives**: Responders earn tokens for successful responses.
- **Security**: All actions are immutable and auditable on the blockchain.

### Tech Stack
- **Blockchain**: Stacks (secured by Bitcoin).
- **Language**: Clarity (functional, predictable smart contracts).
- **Contracts**: 6 core smart contracts (detailed below).
- **Off-Chain Components**: Oracles for location/grid data (e.g., integrating with Chainlink or custom oracles); frontend dApp for users to submit alerts.

### Smart Contracts
DERN consists of 6 solid Clarity smart contracts, each handling a specific aspect for modularity and security:

1. **RegistryContract.clar**: Manages user and responder registrations, including basic profiles and location updates.
2. **VerificationContract.clar**: Handles verification of responders (e.g., via multi-sig or oracle proofs).
3. **AlertContract.clar**: Allows creation and management of emergency alerts.
4. **RoutingContract.clar**: Computes and routes alerts to nearest responders using location logic.
5. **ResponseContract.clar**: Manages responder acceptance, completion, and disputes.
6. **TokenContract.clar**: An FT (fungible token) for rewards and incentives.

These contracts interact via public functions, ensuring composability.

## Installation and Deployment
1. Install Clarinet (Stacks dev tool): `cargo install clarinet`.
2. Clone the repo: `git clone <this repo>`.
3. Navigate to project: `cd dern-project`.
4. Test contracts: `clarinet test`.
5. Deploy to testnet: Use Clarinet or Stacks CLI for deployment.

## Usage
- **Register as Responder**: Call `register-responder` in RegistryContract with your location (lat/long as integers).
- **Verify Responder**: Submit proof to VerificationContract.
- **Create Alert**: Use AlertContract with alert details and location.
- **Routing**: Automatically handled by RoutingContract.
- **Respond**: Accept via ResponseContract and claim rewards from TokenContract.

## Contract Details and Code

Below is the Clarity code for each contract. Deploy them in order (TokenContract first for dependencies).

### 1. RegistryContract.clar
```
;; Registry Contract for users and responders

(define-map users principal { location: (tuple (lat int) (long int)), is-responder: bool })
(define-map responders principal { verified: bool })

(define-public (register-user (lat int) (long int) (as-responder bool))
  (map-set users tx-sender { location: { lat: lat, long: long }, is-responder: as-responder })
  (if as-responder
    (map-set responders tx-sender { verified: false })
    (ok true)
  )
)

(define-read-only (get-user (user principal))
  (map-get? users user)
)

(define-read-only (get-responder (responder principal))
  (map-get? responders responder)
)
```

### 2. VerificationContract.clar
```
;; Verification Contract for responders

(use-trait registry .RegistryContract.users)

(define-data-var verifier principal tx-sender) ;; Admin verifier for simplicity; can be multi-sig

(define-public (verify-responder (responder principal) (proof (buff 32)))
  (if (is-eq tx-sender (var-get verifier))
    (begin
      (try! (contract-call? .RegistryContract set-responder-verified responder true))
      (ok true)
    )
    (err u100) ;; Not authorized
  )
)

;; In a real setup, integrate oracle for proof validation
```

(Note: This assumes RegistryContract has a `set-responder-verified` function; extend as needed.)

### 3. AlertContract.clar
```
;; Alert Creation Contract

(define-map alerts uint { creator: principal, location: (tuple (lat int) (long int)), description: (string-ascii 256), status: (string-ascii 20), grid-data: (optional (buff 128)) })
(define-data-var alert-counter uint u0)

(define-public (create-alert (lat int) (long int) (description (string-ascii 256)) (grid-data (optional (buff 128))))
  (let ((alert-id (var-get alert-counter)))
    (map-set alerts alert-id { creator: tx-sender, location: { lat: lat, long: long }, description: description, status: "open", grid-data: grid-data })
    (var-set alert-counter (+ alert-id u1))
    (ok alert-id)
  )
)

(define-read-only (get-alert (alert-id uint))
  (map-get? alerts alert-id)
)

;; Integrate with national grids via oracle-passed grid-data (e.g., outage info)
```

### 4. RoutingContract.clar
```
;; Routing Contract - Routes to nearest responders

(use-trait registry .RegistryContract.users)

(define-public (route-alert (alert-id uint))
  (let ((alert (unwrap! (contract-call? .AlertContract get-alert alert-id) (err u200)))
        (alert-loc (get location alert)))
    (fold find-nearest (contract-call? .RegistryContract get-all-verified-responders) { nearest: none, min-dist: u999999 })
    ;; Logic to compute distance (simple Euclidean for demo)
    ;; In prod, use better geo-distance formula
  )
)

(define-private (find-nearest (responder principal) (acc { nearest: (optional principal), min-dist: uint }))
  (let ((resp-loc (get location (unwrap! (contract-call? .RegistryContract get-user responder) acc)))
        (dist (calculate-distance alert-loc resp-loc)))
    (if (< dist (get min-dist acc))
      { nearest: (some responder), min-dist: dist }
      acc
    )
  )
)

(define-private (calculate-distance (loc1 (tuple (lat int) (long int))) (loc2 (tuple (lat int) (long int))))
  (+ (pow (- (get lat loc1) (get lat loc2)) u2) (pow (- (get long loc1) (get long loc2)) u2))
)
```

(Note: Extend RegistryContract with `get-all-verified-responders` iterator.)

### 5. ResponseContract.clar
```
;; Response Handling Contract

(define-map responses uint { alert-id: uint, responder: principal, status: (string-ascii 20) })

(define-public (accept-alert (alert-id uint))
  (let ((routed-to (contract-call? .RoutingContract get-routed-responder alert-id)))
    (if (is-eq tx-sender routed-to)
      (map-set responses alert-id { alert-id: alert-id, responder: tx-sender, status: "accepted" })
      (err u300)
    )
  )
)

(define-public (complete-response (alert-id uint) (proof (buff 32)))
  (let ((response (unwrap! (map-get? responses alert-id) (err u301))))
    (if (is-eq tx-sender (get responder response))
      (begin
        (map-set responses alert-id (merge response { status: "completed" }))
        (try! (contract-call? .TokenContract reward-responder tx-sender u100)) ;; Reward 100 tokens
        (ok true)
      )
      (err u302)
    )
  )
)
```

### 6. TokenContract.clar
```
;; Fungible Token Contract for Rewards (STX or custom FT)

(define-fungible-token dern-token u1000000) ;; Total supply

(define-public (reward-responder (responder principal) (amount uint))
  (ft-transfer? dern-token amount tx-sender responder)
)

(define-public (mint (amount uint) (recipient principal))
  (ft-mint? dern-token amount recipient)
)

;; Pre-mint for treasury, etc.
```

## Security Considerations
- Use Clarity's predictability to avoid reentrancy.
- Location data: Handle privacy with opt-in and encryption.
- Oracles: Rely on trusted sources for grid integration to prevent manipulation.
- Audits: Recommend professional audit before mainnet.

## Future Enhancements
- Full oracle integration for real-time national grid data.
- DAO governance for verifier roles.
- Mobile dApp for location sharing.

## License
MIT License. See LICENSE file for details.