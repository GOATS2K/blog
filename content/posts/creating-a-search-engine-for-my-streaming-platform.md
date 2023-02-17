---
title: "Creating a Search Engine For My Music Streaming Platform"
description: "Coral needs a search engine, so let's make one!"
date: "2023-02-17"
tags: ["programming", "coral"]
showComments: true
---

{{< alert "circle-info" >}}
This is an article about **Coral**, a project I'm working on for my final year at university. 
Coral is a self-hosted music streaming platform that solves a lot of problems that I've had with already existing apps such as Jellyfin, Navidrome, Subsonic and Plex.
The application will be __open-sourced and released to the public__ in May-June 2023.
{{< /alert >}}


## Overview

Coral needs a search system.
Here are the features I expect a search system to have.

- Search for an artist
    - `lenzman` → all tracks by Lenzman
- Search for an album
    - `a little while longer` → The album A Little While Longer by Lenzman
- Search for a track
    - `too` → Match all track titles containing the word `too`
- Search for a track with artist name
    - `lenzman starlight` → The track Starlight by Lenzman
    - `starlight lenzman` → The same result
- Search for tracks with partial keywords
    - `lenz star` → The track Starlight by Lenzman
    

This is the test suite we’ll be attempting to pass.

```csharp
[Theory]
[InlineData("starlight")]
[InlineData("star")]
[InlineData("lenzman starlight")]
[InlineData("starlight lenzman")]
[InlineData("starlight a little while longer")]
[InlineData("lenz star")]
public async Task Search_Starlight_FindsTrack(string query)
{
    // arrange
    // generate keywords for all tracks in album
    foreach (var track in _testDatabase.ALittleWhileLonger.Tracks)
    {
        await _searchService.InsertKeywordsForTrack(track);
    }
    var trackToFind = _testDatabase.Starlight;
    
    // act
    var result = await _searchService.Search(query);

    // assert
    Assert.Single(result.Tracks);
    var searchResult = result.Tracks.Single();
    Assert.Equal(trackToFind.Title, searchResult.Title);
}
```

## My first attempt

My first attempt didn’t work very well. It passed the wildcard searches on each individual column, but fell through when the columns were combined. Not only that, but it was slow due to the multiple wildcards and querying for more information than I needed.

```csharp
public async Task<SearchResult> Search(string query)
{
    // % is a wildcard
    var tracks = await _context.Tracks
        .Where(t => EF.Functions.Like(t.Title, $"%{query}%"))
        .ProjectTo<TrackDto>(_mapper.ConfigurationProvider)
        .AsNoTracking()
        .ToListAsync();

    var albums = await _context.Albums
        .Where(a => EF.Functions.Like(a.Name, $"%{query}%"))
        .ProjectTo<SimpleAlbumDto>(_mapper.ConfigurationProvider)
        .AsNoTracking()
        .ToListAsync();

    var artists = await _context.Artists
        .Where(a => EF.Functions.Like(a.Name, $"%{query}%"))
        .ProjectTo<SimpleArtistDto>(_mapper.ConfigurationProvider)
        .AsNoTracking()
        .ToListAsync();

    return new SearchResult()
    {
        Tracks = tracks,
        Artists = artists,
        Albums = albums,
    };
}
```

It was at this point where started looking into how to write a basic search engine. This is where stumbled upon the concept of full-text search and being introduced to the concept of an **************inverted index************** by my dad and [this article](https://nlp.stanford.edu/IR-book/html/htmledition/a-first-take-at-building-an-inverted-index-1.html) from the book [“Introduction to Information Retrieval” by Christopher D. Manning, Prabhakar Raghavan & Hinrich Schütze](https://nlp.stanford.edu/IR-book/). 

## Learning about full-text search

In Coral, I use SQLite via EF Core. Enabling FTS in SQLite can be done by creating a new *virtual* table that will contain the rows to search through. 

```sql
CREATE VIRTUAL TABLE email USING fts5(sender, title, body);
```

However, there are a few caveats with using the database native approach. The biggest issue in my case is that my ORM of choice, EF Core, doesn’t natively support it. Some have tried to make it work with [varying amounts](https://github.com/dotnet/efcore/issues/4823) [of success](https://www.bricelam.net/2020/08/08/sqlite-fts-and-efcore.html). Virtual tables cannot be altered in any other case but title changes - this makes extensibility a bit annoying. I’m sure there are ways you can point the internal `row_id` of the content to the full-text index and work around this, but I honestly stopped researching native FTS after I found out there wasn’t an easy way to set it up using just my ORM.

For the sake of educating myself on how keyword based search systems work, I decided to implement it myself.

## Implementation

{{< alert "circle-info" >}}
My current implementation meets my needs both accuracy and performance wise. In my test collection with a little over 2000 songs, I can query my API hitting over 100+ different tracks with an average response time of **20ms from a cold start.** It’ll be interesting to see how this scales once I let Coral index my whole music collection.
{{< /alert >}}


A full-text search system is basically *an inverted index* of words pointing to a table. Let’s try indexing the following list of tracks.

| ID | Artist | Track Title | Album | Release Year |
| --- | --- | --- | --- | --- |
| 1 | Calibre | Broken | Even If | 2010 |
| 2 | Redeyes | The Hurt (feat. DRS) | Broken Soul | 2018 |
| 3 | Redeyes | Fool of Me | Broken Soul | 2018 |
| 4 | Tatora & Perspective Shift | Brokenhearted | Future Sight | 2020 |

Every word in every row needs to be split and normalized into lowercase alphanumerical characters. This can be done with the following regular expression. The regex matches on alphanumerical characters and captures words split by spaces. The asterisk on the word boundary ensures that we match on single letters as well.

```csharp
private List<string> ProcessInputString(string inputString)
{
    // split by word boundary and alphanumerical values
    var pattern = @"([a-zA-Z0-9])\w*";
    var matches = Regex.Matches(inputString, pattern);
    // return split
    return matches?.Select(m => m.Value.ToLower()).Distinct().ToList() ?? new List<string>();
}
```

The first track can then be represented like this:

```
calibre broken even if 2010
```

Then the second track like so:

```
redeyes the hurt feat drs broken soul 2018
```

### Storing the keywords

Before I introduce the function that maps keywords to tracks, we’ll need to figure out how we’re going to store the keywords in the first place. This is what the `Keyword` model looks like.

```csharp
public class Keyword
{
    public int Id { get; set; }
    public string Value { get; set; } = null!;
    public List<Track> Tracks { get; set; } = null!;
}
```

It stores the keyword and has a navigation property (foreign key) pointing to the Track model. I’ve also set EF Core to create an index for our keywords for faster lookups.

```csharp
public class KeywordConfiguration : IEntityTypeConfiguration<Keyword>
{
    public void Configure(EntityTypeBuilder<Keyword> builder)
    {
        builder.Property(p => p.Value).IsRequired();
        builder.HasIndex(p => p.Value);
    }
}
```

Let’s look at the track model, we’ll be interacting with this in the keyword insertion function.

```csharp
public class Track
{
    public int Id { get; set; }
    public string Title { get; set; } = null!;
    public Artist Artist { get; set; } = null!;
    public Album Album { get; set; } = null!;
    public List<Keyword> Keywords { get; set; } = null!;

		public override string ToString()
    {
        var releaseYear = Album.ReleaseYear != null ? $"({Album.ReleaseYear})" : "";
        return $"{Artist.Name} - {Title} - {Album.Name} {releaseYear}";
    }
}
```

A few properties have been omitted for brevity. Let’s look at the function responsible for inserting keywords.

```csharp
public async Task InsertKeywordsForTrack(Track track)
{
    var keywords = ProcessInputString(track.ToString());
    // check for existing keywords
    var existingKeywords = await _context
        .Keywords
        .Where(k => keywords.Contains(k.Value))
        .ToListAsync();

    var missingKeywordsOnTrack = existingKeywords
        .Where(k => !track.Keywords.Contains(k))
        .ToList();

    // in the event we've indexed all the keywords present on a track before
    if (existingKeywords.Count() == keywords.Count() 
        && missingKeywordsOnTrack.Count() == 0)
    {
        return;
    }

    foreach (var missingKeyword in missingKeywordsOnTrack)
    {
        // if existing keyword is not on track, add to track
        track.Keywords.Add(missingKeyword);

        // remove keyword from list of incoming keywords
        keywords.Remove(missingKeyword.Value);
    }

    if (keywords.Count > 0)
    {
        var newKeywords = keywords.Select(k => new Keyword()
        {
            Value = k
        });
        track.Keywords.AddRange(newKeywords);
    }
    await _context.SaveChangesAsync();
}
```

First, we create keywords for the track via its `ToString` method. Then we check if we’ve already stored matching keywords before and if so, set those matching keywords on the track. If we have any new keywords, add those as well. 

Simple enough. The search function is where things start to get interesting.

### The search function!

The usual way of getting database rows where a column is present in a list would be something like this.

```csharp
var list = new List<string>(){"hello", "reader", "ur_very_cool_hihi"};
_context.Table.Where(i => list.Contains(i.Text));
```

The drawback with this is that it needs to be a full match, both in letter case and the text itself. Most search systems these days allow for some sort of partial match, which can be tremendously helpful in finding things quickly - although it can have a negative impact on performance if it’s not properly implemented. 

In order to support wildcard queries, I have used a library called [LINQKit](https://github.com/scottksmith95/LINQKit) to dynamically generate [predicates](https://learn.microsoft.com/en-us/dotnet/api/system.predicate-1?view=net-7.0) for the database query - which allows me to use `EF.Functions.Like` which usually only supports checking single values.

```csharp
private ExpressionStarter<Keyword> GenerateSearchQueryForKeywords(List<string> keywords)
{
    var predicate = PredicateBuilder.New<Keyword>();
    foreach (var keyword in keywords)
    {
        // I chose to only set the wildcard on the end of the keyword
        // for performance reasons - benefiting from indexing done by the database
        predicate = predicate
            .Or(k => EF.Functions.Like(k.Value, $"{keyword}%"));
    }
    return predicate;
}
```

```csharp
public async Task<SearchResult> Search(string query)
{
    // get all tracks matching keywords
    var keywords = ProcessInputString(query);
    var trackIds = await _context.Keywords
        .Where(GenerateSearchQueryForKeywords(keywords))
        .Select(k => k.Tracks)
        .SelectMany(t => t)
        .Select(t => t.Id)
        .ToListAsync();

    var idGroups = trackIds.GroupBy(t => t);
    // get only the IDs matching the query
    var idsMatchingQuery = idGroups
        .Where(g => g.Count() == keywords.Count())        .Select(g => g.Key);

    // fetch tracks matching query
    var tracks = await _context.Tracks
        .Where(t => idsMatchingQuery.Contains(t.Id))
        .ProjectTo<TrackDto>(_mapper.ConfigurationProvider)
        .ToListAsync();

    return new SearchResult()
    {
        Albums = tracks.Select(t => t.Album)
        .Distinct(new SimpleAlbumDtoComparer())
        .ToList(),
        Artists = tracks.Select(t => t.Artist)
        .Distinct(new SimpleArtistDtoComparer())
        .ToList(),
        Tracks = tracks
    };
}
```

Let's go over the search function. First, we query the database for the keywords using our dynamic query builder. We select the tracks from that query, flatten the list of track lists using `SelectMany` and then select the IDs of the tracks we're interested in. By only selecting the IDs, we can filter the matches before getting the track data, which allows for more performant queries. 

Refer back to the data table we created earlier. If I search for `broken` - I’ll get every track in the table. Tracks 1 and 4 had the term in their title, while 2 and 3 had it in their album tags. If I search for `broken soul`, it will first match with all the tracks, and then `soul` will match with tracks 2 and 3. Because `soul` has tracks 2 and 3 in common with `broken`, we can tell that they are related to the query as a whole and thereby matching with the album tag Broken Soul.

Based on this knowledge, we know if a track ID is repeated **n** times, where *n* is the number of segments in the query, that those tracks match the entire query.

Once we have the tracks matching the query, we can fetch them from the database. I am using the AutoMapper function `ProjectTo` to select only the data we need. Finally, we can use the data gathered from all the tracks to assemble a list of search results containing every artist and album referenced by the tracks we found.

## Summary
We've just built a highly performant search system that can help users find their music with little effort. I've had countless ideas about extending the search algorithm to also index label names, catalog numbers, genres, lyrics, etc.
Imagine how cool it would be to search for a part of a lyric and just find the song you're looking for...

Now it's just a question of scalability - how will it perform when you through 50,000+ tracks at it?

I'll be writing more about the fun stuff I make while hacking on Coral.
There's also an [RSS feed you can subscribe to](/index.xml) want to keep up to date with my latest articles.

See you in the next one!