<?php
require_once __DIR__ . '/db.php';

$pdo = getDBConnection();
$method = $_SERVER['REQUEST_METHOD'];

// Ensure verification table exists
try {
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS email_verifications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) NOT NULL,
            otp_code VARCHAR(10) NOT NULL,
            expires_at DATETIME NOT NULL,
            verified TINYINT(1) DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_email (email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    ");
} catch (Exception $e) {
    // Ignore if already exists or permissions
}

if ($method === 'POST') {
    $input = getJsonInput();
    $action = $input['action'] ?? 'send-otp';

    // 1. Send OTP
    if ($action === 'send-otp') {
        $email = trim(strtolower($input['email'] ?? ''));

        if (empty($email)) {
            sendJsonResponse(['success' => false, 'error' => 'Email address is required.'], 400);
        }

        // Validate basic email format
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            sendJsonResponse(['success' => false, 'error' => 'Please provide a valid email format.'], 400);
        }

        // Validate Google Account domain (must be @gmail.com or Google Workspace domain)
        $domain = substr(strrchr($email, "@"), 1);
        $isGmail = ($domain === 'gmail.com' || $domain === 'googlemail.com');

        // Optional check for Google MX records if custom domain
        $hasGoogleMx = false;
        if (!$isGmail && function_exists('checkdnsrr')) {
            $hasMx = checkdnsrr($domain, 'MX');
            if ($hasMx) {
                // If MX exists, check if google
                $mxRecords = [];
                getmxrr($domain, $mxRecords);
                foreach ($mxRecords as $mx) {
                    if (stripos($mx, 'google') !== false || stripos($mx, 'googlemail') !== false) {
                        $hasGoogleMx = true;
                        break;
                    }
                }
            }
        }

        if (!$isGmail && !$hasGoogleMx) {
            sendJsonResponse([
                'success' => false,
                'error' => 'A valid Google Account (@gmail.com or verified Google Workspace) is required to register.'
            ], 400);
        }

        // Generate 6-digit numeric OTP
        $otp = str_pad((string)random_int(100000, 999999), 6, '0', STR_PAD_LEFT);
        $expiresAt = date('Y-m-d H:i:s', strtotime('+10 minutes'));

        // Save to database
        try {
            $del = $pdo->prepare("DELETE FROM email_verifications WHERE email = ?");
            $del->execute([$email]);

            $ins = $pdo->prepare("INSERT INTO email_verifications (email, otp_code, expires_at, verified) VALUES (?, ?, ?, 0)");
            $ins->execute([$email, $otp, $expiresAt]);

            // Attempt PHP mail() delivery
            $subject = "Lambawasa Utility - Google Account Verification OTP: {$otp}";
            $messageBody = "Hello,\n\nYour 6-digit verification code for Lambawasa Water District consumer registration is:\n\n{$otp}\n\nThis code will expire in 10 minutes.\nIf you did not request this code, please disregard this message.\n\nLambawasa Municipal Water District";
            $headers = "From: no-reply@lambawasa.gov.ph\r\n" .
                       "Reply-To: support@lambawasa.gov.ph\r\n" .
                       "X-Mailer: PHP/" . phpversion();

            @mail($email, $subject, $messageBody, $headers);

            // Audit
            try {
                $insAudit = $pdo->prepare("
                    INSERT INTO audit_trail (log_code, user_id, user_name, user_role, category, action, target_entity, details, ip_address)
                    VALUES (?, 0, 'Consumer Registration', 'Guest', 'Security', 'Dispatched Google OTP', ?, ?, ?)
                ");
                $insAudit->execute([
                    'AUD-' . rand(1000, 9999),
                    $email,
                    "Dispatched 6-digit OTP to Google Account {$email}.",
                    $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1'
                ]);
            } catch (Exception $ignored) {}

            sendJsonResponse([
                'success' => true,
                'message' => "Verification OTP dispatched to {$email}.",
                'email' => $email,
                'expiresIn' => 600
            ]);
        } catch (Exception $e) {
            sendJsonResponse(['success' => false, 'error' => 'Failed to generate verification OTP: ' . $e->getMessage()], 500);
        }
    }

    // 2. Verify OTP
    if ($action === 'verify-otp') {
        $email = trim(strtolower($input['email'] ?? ''));
        $otp = trim($input['otp'] ?? '');

        if (empty($email) || empty($otp)) {
            sendJsonResponse(['success' => false, 'error' => 'Email and OTP code are required.'], 400);
        }

        try {
            $stmt = $pdo->prepare("SELECT * FROM email_verifications WHERE email = ? AND otp_code = ? ORDER BY id DESC LIMIT 1");
            $stmt->execute([$email, $otp]);
            $record = $stmt->fetch();

            if (!$record) {
                sendJsonResponse(['success' => false, 'error' => 'Incorrect verification code. Please check the OTP sent to your Google account.'], 400);
            }

            if (strtotime($record['expires_at']) < time()) {
                sendJsonResponse(['success' => false, 'error' => 'Verification code has expired. Please request a new OTP.'], 400);
            }

            // Mark as verified
            $upd = $pdo->prepare("UPDATE email_verifications SET verified = 1 WHERE id = ?");
            $upd->execute([$record['id']]);

            sendJsonResponse([
                'success' => true,
                'verified' => true,
                'email' => $email,
                'message' => 'Google account verified successfully.'
            ]);
        } catch (Exception $e) {
            sendJsonResponse(['success' => false, 'error' => 'Verification check failed: ' . $e->getMessage()], 500);
        }
    }
}

sendJsonResponse(['success' => false, 'error' => 'Method not supported.'], 405);
