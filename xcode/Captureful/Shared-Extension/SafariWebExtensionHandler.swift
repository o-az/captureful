//
//  SafariWebExtensionHandler.swift
//  Shared-Extension
//
//  Created by devin on 05/10/2026.
//

import os.log
import SafariServices

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message = request?.userInfo?[SFExtensionMessageKey]

        os_log(
            .default,
            "Received message from browser.runtime.sendNativeMessage: %@ (profile: %@)",
            String(describing: message),
            profile?.uuidString ?? "none"
        )

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["echo": message]]

        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
