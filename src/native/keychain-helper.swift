import Foundation
import Security

// Secrets travel only over the parent process pipes, never argv or a shell.
// This helper cannot address another application's Keychain namespace.
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
    }
}
func failure(_ code: String) -> Never { emit(["ok": false, "code": code]); exit(1) }
let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 65536,
      let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any],
      let action = request["action"] as? String,
      ["insert", "read", "remove"].contains(action),
      let account = request["account"] as? String,
      account.range(of: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$", options: .regularExpression) != nil
else { failure("invalid_request") }
let namespace = request["namespace"] as? String ?? "production"
guard namespace == "production" || namespace.range(of: "^qa-[a-f0-9-]{36}$", options: .regularExpression) != nil else { failure("invalid_namespace") }
let service = "GuanAIWorkbench.CredentialVault." + namespace
var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecAttrSynchronizable as String: false,
    kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail
]
var status: OSStatus
switch action {
case "insert":
    guard let secret = request["secret"] as? String, !secret.isEmpty,
          secret.utf8.count <= 16384, !secret.contains("\0") else { failure("invalid_secret") }
    query[kSecValueData as String] = Data(secret.utf8)
    status = SecItemAdd(query as CFDictionary, nil)
case "remove":
    status = SecItemDelete(query as CFDictionary)
    if status == errSecItemNotFound { status = errSecSuccess }
default:
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var value: CFTypeRef?
    status = SecItemCopyMatching(query as CFDictionary, &value)
    if status == errSecItemNotFound { emit(["ok": true, "value": NSNull()]); exit(0) }
    if status == errSecSuccess {
        guard let data = value as? Data, let secret = String(data: data, encoding: .utf8) else { failure("invalid_value") }
        emit(["ok": true, "value": secret]); exit(0)
    }
}
if status == errSecSuccess { emit(["ok": true]); exit(0) }
if status == errSecDuplicateItem { failure("item_exists") }
if status == errSecInteractionNotAllowed || status == errSecAuthFailed || status == errSecUserCanceled { failure("authorization_required") }
failure("keychain_unavailable")
