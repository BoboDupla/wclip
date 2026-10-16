The more I learn about Unix tools, the more I realise we are reinventing everyday Rube Goldberg’s wheels and that Unix tools are, often, elegantly enough.

Months ago, I discovered calendar.txt. A simple file with all your dates which was so simple and stupid that I wondered 1) why I didn’t think about it myself and, 2) how it could be useful.

- [Calendar.txt (terokarvinen.com)](https://terokarvinen.com/2021/calendar-txt/)

I downloaded the file and tried it. Without thinking much about it, I realised that I could add the following line to my offpunk startup:

> !grep \`date -I\` calendar.txt --color

And, just like that, I suddenly have important things for my day everytime I start Offpunk. In my "do\_the\_internet.sh", I added the following:

> grep \`date -I\`calendar.txt --color -A 7

Which allows me to have an overview of the next seven days.

But what about editing? This is the alias I added to my shell to automatically edit today’s date:

> alias calendar="vim +/\`date -I\` ~/inbox/calendar.txt"

It feels so easy, so elegant, so simple. All those aliases came naturally, without having to spend more than a few seconds in the man page of "date". No need to fiddle with a heavy web interface. I can grep through my calendar. I can edit it with vim. I can share it, save it and synchronise it without changing anything else, without creating any account. Looking for a date, even far in the future, is as simple as typing "/YEAR-MONTH-DAY" in vim.

## Recurring events

The icing on the cake became apparent when I received my teaching schedule for the next semester. I had to add a recurring event every Tuesday minus some special cases where the university is closed.

Not a big deal. I do it each year, fiddling with the web interface of my calendar to find the good options to make the event recurrent then removing those special cases without accidentally removing the whole series.

It takes at most 10 minutes, 15 if I miss something. Ten minutes of my life that I hate, forced to use a mouse and click on menus which are changing every 6 months because, you know, "yeah, redesign".

But, with my calendar.txt, it takes exactly 15 seconds.

> /Tue

To find the first Tuesday.

> i

To write the course number and classroom number, escape then

> n.n.n.n.n.n.nn.n.n.n.nn.n.n.n.n.

I’m far from being a Vim expert but this occurred naturally, without really thinking about the tool. I was only focused on the date being correct. It was quick and pleasant.

## Shared events and collaboration

I read my email in Neomutt. When I’m invited to an event, I must open a browser to access the email through my webmail and click the "Yes" button in order to have it added to my calendar. Events I didn’t respond show in my calendar, even if I don’t want them. It took me some settings-digging not to display events I refused. Which is kinda dumb but so are the majority of our tools those days.

With calendar.txt, I manually enter the details from the invitation, which is not perfect but takes less time than opening a browser, login into a webmail and clicking a button while waiting at each step the loading of countless of JavaScript libraries.

Invitations are rare enough that I don’t mind entering the details by hand. But I’m thinking about doing a small bash script that would read an ICS file and add it to calendar.txt. It looks quite easy to do.

I also thought about doing the reverse: a small script that would create an ICS and send it by email to any address added to an event. But it would be hard to track down which events were already sent and which ones are new. Let’s stick to the web interface when I need to create a shared event.

Calendar.txt should remain simple and for my personal use. The point of Unix tools is to allow you to create the tools you need for yourself, not create a startup with a shiny name/logo that will attract investors hoping to make billions in a couple of years by enshitifying the life of captive users.

And when you work with a team, you are stuck anyway with the worst possible tool that satisfies the need of the dumbest member of the team. Usually the manager.

With Unix tools, each solution is personal and different from the others.

- [Other source of inspiration: Jouraling with neovim/coreutils and dateutils (tangled.sh)](https://tangled.sh/@oppi.li/journal)

## Simplifying calendaring

Another unexpected advantage of the system is that you don’t need to guess the end date of events anymore. All I need to know is that I have a meeting at 10 and a lunch at 12. I don’t need to estimate the duration of the meeting which is, anyway, usually only a rough estimation and not an important information. But you can’t create an event in modern calendar without giving a precise end.

Calendar.txt is simple, calendar.txt is good.

I can add events without thinking about it, without calendaring being a chore. Sandra explains how she realised that using an online calendar was a chore when she started to use a paper agenda.

- [When calendar was a verb (idiomdrottning.org)](https://idiomdrottning.org/calendaring)

Going back to a paper calendar is probably something I will end up doing but, in the meantime, calendar.txt is a breeze.

## Trusting my calendar

Most importantly, I now trust my calendar.

I’ve been burned by this before: I had created my whole journey to a foreign country on my online calendar only to discover upon landing that my calendar had decided to be "smart" and to change all events because I was not in the same time zone. Since then, I actually write the time of an event in the title of the event, even if it looks redundant. This also helps with events being moved by accident while scrolling on a smartphone or in a browser. Which is rare but happened enough to make me anxious.

I had the realisation that I don’t trust any calendar application because, for events with a very precise time (like a train), I always fall back on checking the confirmation email or PDFs.

It’s not the case anymore with calendar.txt. I trust the file. I trust the tool.

There are not many tools you can trust.

## Mobile calendar.txt

I don’t need notifications about events on my smartphone. If a notification tells me about an event I forgot, it would be too late anyway. And if my phone is on silent, like always, the notification is useless anyway. We killed notifications with too much notification, something I addressed here:

- [Une vie sans notifications (ploum.net)](https://ploum.net/2025-09-02-mudita.html)

I do want to consult/edit my calendar on my phone. Getting the file on my phone is easy as having it synchronised with my computer through any mean. It’s a simple txt file.

Using it is another story.

Looking at my phone, I realise how far we have fallen: Android doesn’t allow me to do a simple shortcut to that calendar.txt file which would open on the current day. There’s probably a way but I can’t think of one. Probably because I don’t understand that system. After all, I’m not supposed to even try understanding it.

Android is not Unix. Android, like other proprietary Operating System, is a cage you need to fight against if you don’t want to surrender your choices, your data, your soul. Unix is freedom: hard to conquer but impossible to let go as soon as you tasted it.
