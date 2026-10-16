Tracking code that Meta and Russia-based Yandex embed into millions of websites is de-anonymizing visitors by abusing legitimate Internet protocols, causing Chrome and other browsers to surreptitiously send unique identifiers to native apps installed on a device, [researchers have discovered](https://localmess.github.io/). Google says it’s investigating the abuse, which allows Meta and Yandex to convert ephemeral web identifiers into persistent mobile app user identities.

The covert tracking—implemented in the [Meta Pixel](https://www.facebook.com/business/tools/meta-pixel/) and [Yandex Metrica](https://ads.yandex/metrica) trackers—allows Meta and Yandex to bypass core security and privacy protections provided by both the Android operating system and browsers that run on it. [Android sandboxing](https://source.Android.com/docs/security/app-sandbox), for instance, isolates processes to prevent them from interacting with the OS and any other app installed on the device, cutting off access to sensitive data or privileged system resources. Defenses such as [state](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/State_Partitioning) [partitioning](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/State_Partitioning) and [storage partitioning](https://privacysandbox.google.com/cookies/storage-partitioning), which are built into all major browsers, store site cookies and other data associated with a website in containers that are unique to every top-level website domain to ensure they’re off-limits for every other site.

## A blatant violation

“One of the fundamental security principles that exists in the web, as well as the mobile system, is called sandboxing,” Narseo Vallina-Rodriguez, one of the researchers behind the discovery, said in an interview. “You run everything in a sandbox, and there is no interaction within different elements running on it. What this attack vector allows is to break the sandbox that exists between the mobile context and the web context. The channel that exists allowed the Android system to communicate what happens in the browser with the identity running in the mobile app.”

The bypass—which Yandex began in 2017 and Meta started last September—allows the companies to pass cookies or other identifiers from Firefox and Chromium-based browsers to native Android apps for Facebook, Instagram, and various Yandex apps. The companies can then tie that vast browsing history to the account holder logged into the app.

This abuse has been observed only in Android, and evidence suggests that the Meta Pixel and Yandex Metrica target only Android users. The researchers say it may be technically feasible to target iOS because browsers on that platform allow developers to programmatically [establish localhost connections](https://bugs.webkit.org/show_bug.cgi?id=279249) that apps can monitor on local ports.

In contrast to iOS, however, Android imposes fewer controls on local host communications and background executions of mobile apps, the researchers said, while also implementing stricter controls in app store vetting processes to limit such abuses. This overly permissive design allows Meta Pixel and Yandex Metrica to send web requests with web tracking identifiers to specific local ports that are continuously monitored by the Facebook, Instagram, and Yandex apps. These apps can then link pseudonymous web identities with actual user identities, even in private browsing modes, effectively de-anonymizing users’ browsing habits on sites containing these trackers.

Meta Pixel and Yandex Metrica are analytics scripts designed to help advertisers measure the effectiveness of their campaigns. Meta Pixel and Yandex Metrica are estimated to be installed on [5.8 million](https://trends.builtwith.com/websitelist/Facebook-Pixel%20) and [3 million](https://trends.builtwith.com/analytics/Yandex-Metrika) sites, respectively.

Meta and Yandex achieve the bypass by abusing basic functionality built into modern mobile browsers that allows browser-to-native app communications. The functionality lets browsers send web requests to local Android ports to establish various services, including media connections through the [RTC protocol](https://en.wikipedia.org/wiki/Real-time_communication), file sharing, and developer debugging.

              A conceptual diagram representing the exchange of identifiers between the web trackers running on the browser context and native Facebook, Instagram, and Yandex apps for Android.

          While the technical underpinnings differ, both Meta Pixel and Yandex Metrica are performing a “weird protocol misuse” to gain unvetted access that Android provides to [localhost ports](https://stackoverflow.com/questions/1946193/whats-the-whole-point-of-localhost-hosts-and-ports-at-all) on the 127.0.0.1 IP address. Browsers access these ports without user notification. Facebook, Instagram, and Yandex native apps silently listen on those ports, copy identifiers in real time, and link them to the user logged into the app.

A representative for Google said the behavior violates the terms of service for its Play marketplace and the privacy expectations of Android users.

“The developers in this report are using capabilities present in many browsers across iOS and Android in unintended ways that blatantly violate our security and privacy principles,” the representative said, referring to the people who write the Meta Pixel and Yandex Metrica JavaScript. “We’ve already implemented changes to mitigate these invasive techniques and have opened our own investigation and are directly in touch with the parties.”

Meta didn’t answer emailed questions for this article, but provided the following statement: “We are in discussions with Google to address a potential miscommunication regarding the application of their policies. Upon becoming aware of the concerns, we decided to pause the feature while we work with Google to resolve the issue.”

In an email, Yandex said it was discontinuing the practice and was also in touch with Google.

“Yandex strictly complies with data protection standards and does not de-anonymize user data,” the statement added. “The feature in question does not collect any sensitive information and is solely intended to improve personalization within our apps.”

## How Meta and Yandex de-anonymize Android users

Meta Pixel developers have abused various protocols to implement the covert listening since the practice began last September. They started by causing apps to send HTTP requests to port 12387. A month later, Meta Pixel stopped sending this data, even though Facebook and Instagram apps continued to monitor the port.

In November, Meta Pixel switched to a new method that invoked WebSocket, a protocol for two-way communications, over port 12387.

That same month, Meta Pixel also deployed a new method that used [WebRTC](https://en.wikipedia.org/wiki/WebRTC), a real-time peer-to-peer communication protocol commonly used for making audio or video calls in the browser. This method used a complicated process known as [SDP munging](https://webrtchacks.com/not-a-guide-to-sdp-munging/), a technique for JavaScript code to modify Session Description Protocol data before it’s sent. Still in use today, the SDP munging by Meta Pixel inserts key _fbp cookie content into fields meant for connection information. This causes the browser to send that data as part of a [STUN request](https://en.wikipedia.org/wiki/STUN) to the Android local host, where the Facebook or Instagram app can read it and link it to the user.

In May, a [beta version](https://groups.google.com/g/discuss-webrtc/c/PIJZN5MTZF4/m/JHVmmn8yDgAJ?pli=1) of Chrome introduced a mitigation that blocked the type of SDP munging that Meta Pixel used. Within days, Meta Pixel circumvented the mitigation by adding a new method that swapped the STUN requests with the [TURN requests](https://en.wikipedia.org/wiki/Traversal_Using_Relays_around_NAT).

        ![](https://cdn.arstechnica.net/wp-content/uploads/2025/06/meta-pixel-transmitting-fbp-cookie-640x187.jpg)

In a [post](link), the researchers provided a detailed description of the _fbp cookie from a website to the native app and, from there, to the Meta server:

1. The user opens the native Facebook or Instagram app, which eventually is sent to the background and creates a background service to listen for incoming traffic on a TCP port (12387 or 12388) and a UDP port (the first unoccupied port in 12580–12585). Users must be logged-in with their credentials on the apps.

2. The user opens their browser and visits a website integrating the Meta Pixel.

3. At this stage, some websites wait for users’ consent before embedding Meta Pixel. In our measurements of the top 100K website homepages, we found websites that require consent to be a minority (more than 75% of affected sites does not require user consent)…

4. The Meta Pixel script is loaded and the _fbp cookie is sent to the native Instagram or Facebook app via WebRTC (STUN) SDP Munging.

5. The Meta Pixel script also sends the _fbp value in a request to https://www.facebook.com/tr along with other parameters such as page URL (dl), website and browser metadata, and the event type (ev) (e.g., PageView, AddToCart, Donate, Purchase).

6. The Facebook or Instagram apps receive the _fbp cookie from the Meta JavaScripts running on the browser and transmits it to the GraphQL endpoint (https://graph[.]facebook[.]com/graphql) along with other persistent user identifiers, linking users’ fbp ID (web visit) with their Facebook or Instagram account.

              Detailed flow of the way the Meta Pixel leaks the _fbp cookie from Android browsers to it’s Facebook and Instagram apps.

          The first known instance of Yandex Metrica linking websites visited in Android browsers to app identities was in May 2017, when the tracker started sending HTTP requests to local ports 29009 and 30102. In May 2018, Yandex Metrica also began sending the data through HTTPS to ports 29010 and 30103. Both methods remained in place as of publication time.

An overview of Yandex identifier sharing

              A timeline of web history tracking by Meta and Yandex

          Some browsers for Android have blocked the abusive JavaScript in trackers. DuckDuckGo, for instance, was already blocking domains and IP addresses associated with the trackers, preventing the browser from sending any identifiers to Meta. The browser also blocked most of the domains associated with Yandex Metrica. After the researchers notified DuckDuckGo of the incomplete blacklist, developers added the missing addresses.

The Brave browser, meanwhile, also blocked the sharing of identifiers due to its extensive blocklists and existing mitigation to [block requests](https://brave.com/privacy-updates/27-localhost-permission/) to the localhost without explicit user consent. Vivaldi, another Chromium-based browser, forwards the identifiers to local Android ports when the default privacy setting is in place. Changing the setting to block trackers appears to thwart browsing history leakage, the researchers said.

              Tracking blocker settings in Vivaldi for Android.

          The various remedies DuckDuckGo, Brave, Vivaldi, and Chrome have put in place are working as intended, but the researchers caution they could become ineffective at any time.

“Any browser doing blocklisting will likely enter into a constant arms race, and it’s just a partial solution,” Vallina Rodriguez said of the current mitigations. “Creating effective blocklists is hard, and browser makers will need to constantly monitor the use of this type of capability to detect other hostnames potentially abusing localhost channels and then updating their blocklists accordingly.”

He continued:

While this solution works once you know the hostnames doing that, it’s not the right way of mitigating this issue, as trackers may find ways of accessing this capability (e.g., through more ephemeral hostnames). A long-term solution should go through the design and development of privacy and security controls for localhost channels, so that users can be aware of this type of communication and potentially enforce some control or limit this use (e.g., a permission or some similar user notifications).

Chrome and most other Chromium-based browsers executed the JavaScript as Meta and Yandex intended. Firefox did as well, although for reasons that aren’t clear, the browser was not able to successfully perform the SDP munging specified in later versions of the code. After blocking the STUN variant of SDP munging in the early May beta release, a production version of Chrome released [two weeks ago](https://developer.chrome.com/release-notes/137) began blocking both the STUN and TURN variants. Other Chromium-based browsers are likely to implement it in the coming weeks. A representative for Firefox-maker Mozilla said the organization prioritizes user privacy and is taking the report seriously

“We are actively investigating the reported behavior, and working to fully understand its technical details and implications,” Mozilla said in an email. “Based on what we’ve seen so far, we consider these to be severe violations of our anti-tracking policies, and are assessing solutions to protect against these new tracking techniques.”

The researchers warn that the current fixes are so specific to the code in the Meta and Yandex trackers that it would be easy to bypass them with a simple update.

“They know that if someone else comes in and tries a different port number, they may bypass this protection,” said Gunes Acar, the researcher behind the initial discovery, referring to the Chrome developer team at Google. “But our understanding is they want to send this message that they will not tolerate this form of abuse.”

Fellow researcher Vallina-Rodriguez said the more comprehensive way to prevent the abuse is for Android to overhaul the way it handles access to local ports.

“The fundamental issue is that the access to the local host sockets is completely uncontrolled on Android,” he explained. “There’s no way for users to prevent this kind of communication on their devices. Because of the dynamic nature of JavaScript code and the difficulty to keep blocklists up to date, the right way of blocking this persistently is by limiting this type of access at the mobile platform and browser level, including stricter platform policies to limit abuse.”

## Got consent?

The researchers who made this discovery are:

- Aniketh Girish, PhD student at [IMDEA Networks](https://networks.imdea.org)
- Gunes Acar, assistant professor in [Radboud University’s](https://www.ru.nl/en/institute-for-computing-and-information-sciences) Digital Security Group & iHub
- Narseo Vallina-Rodriguez, associate professor at IMDEA Networks
- Nipuna Weerasekara, PhD student at IMDEA Networks
- Tim Vlummens, PhD student at [COSIC, KU Leuven](https://www.esat.kuleuven.be)

Acar said he first noticed Meta Pixel accessing local ports while visiting his own university’s website.

There’s no indication that Meta or Yandex has disclosed the tracking to either websites hosting the trackers or end users who visit those sites. Developer forums show that many websites using Meta Pixel were caught off guard when the scripts began connecting to local ports.

“Since 5th September, our internal JS error tracking has been flagging failed fetch requests to localhost:12387,” one developer [wrote](https://developers.facebook.com/community/threads/317050484803752/). “No changes have been made on our side, and the existing Facebook tracking pixel we use loads via Google Tag Manager.”

“Is there some way I can disable this?” another developer encountering the unexplained local port access [asked](https://developers.facebook.com/community/threads/937149104821259/).

It’s unclear whether browser-to-native-app tracking violates any privacy laws in various countries. Both Meta and companies hosting its Meta Pixel, however, [have](https://arstechnica.com/tech-policy/2022/09/lawsuits-say-meta-evaded-apple-privacy-settings-to-spy-on-millions-of-users/) [faced](https://arstechnica.com/tech-policy/2022/11/major-tax-filing-websites-secretly-share-income-data-with-meta/) a [raft](https://arstechnica.com/tech-policy/2023/07/meta-wont-say-what-happened-to-taxpayer-data-it-may-have-illegally-collected/) of [lawsuits](https://arstechnica.com/tech-policy/2024/02/amc-to-pay-8m-for-allegedly-violating-1988-law-with-use-of-meta-pixel/) in recent years alleging that the data collected violates privacy statutes. A [research paper](https://arxiv.org/pdf/2208.00710) from 2023 found that Meta pixel, then called the Facebook Pixel, “tracks a wide range of user activities on websites with alarming detail, especially on websites classified as sensitive categories under GDPR,” the abbreviation for the European Union’s General Data Protection Regulation.

So far, Google has provided no indication that it plans to redesign the way Android handles local port access. For now, the most comprehensive protection against Meta Pixel and Yandex Metrica tracking is to refrain from installing the Facebook, Instagram, or Yandex apps on Android devices.