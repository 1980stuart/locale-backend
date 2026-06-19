import { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  ScrollView, StyleSheet, ActivityIndicator,
  Pressable, ImageBackground, Linking, Image, Modal,
  KeyboardAvoidingView, Platform, Animated, Keyboard, Share
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BACKEND_URL, GOOGLE_KEY, UNSPLASH_KEY } from './config';

const TURQUOISE = '#039be5';
const BG = '#edfafa';
const DARK = '#1a1a1a';
const GREY = '#888';
const WHITE = '#ffffff';

const PRELOAD_ENABLED = true;
const PRELOAD_CATEGORIES = ['essentials', 'neighbourhoods', 'coffee', 'food', 'eating', 'markets', 'art', 'walk', 'events', 'drink', 'night', 'mustsee'];

const DIETARY_FILTERS = [
  { key: 'all', label: 'All', icon: '🍽️' },
  { key: 'vegetarian', label: 'Veg', icon: '🌱' },
  { key: 'vegan', label: 'Vegan', icon: '🌿' },
  { key: 'halal', label: 'Halal', icon: '☪️' },
  { key: 'kosher', label: 'Kosher', icon: '✡️' },
  { key: 'pescatarian', label: 'Pesc', icon: '🐟' },
  { key: 'glutenfree', label: 'GF', icon: '🌾' },
];

const CATEGORIES = [
  { key: 'essentials', icon: '📦', label: 'Essentials', teaser: 'Weather, currency, getting around' },
  { key: 'neighbourhoods', icon: '🏘️', label: 'Neighbourhoods', teaser: 'Where locals actually stay' },
  { key: 'coffee', icon: '☕', label: 'Coffee', teaser: 'Open before 8am, near you' },
  { key: 'food', icon: '🍜', label: 'Food', teaser: 'Iconic dishes & street food' },
  { key: 'eating', icon: '🍽️', label: 'Eating', teaser: 'Where locals actually eat' },
  { key: 'markets', icon: '🛍️', label: 'Markets', teaser: 'Street, food & specialist' },
  { key: 'art', icon: '🎨', label: 'Art', teaser: 'World class & hidden works' },
  { key: 'walk', icon: '🚶', label: 'Walk', teaser: 'Local routes & free tours' },
  { key: 'events', icon: '🎭', label: 'Events', teaser: 'What\'s on in the city' },
  { key: 'drink', icon: '🍷', label: 'Drink', teaser: 'Local drinks & bars' },
  { key: 'night', icon: '🌙', label: 'Night', teaser: 'Only here after dark' },
  { key: 'mustsee', icon: '👁️', label: 'Must See', teaser: 'The oracle\'s top picks' },
];


function EyeLoader({ size = 64, progress = 0 }) {
  const pulse = useRef(new Animated.Value(0.85)).current;
  const fillAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.85, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  useEffect(() => {
    const target = progress > 0 ? progress : 0.06;
    Animated.timing(fillAnim, {
      toValue: target,
      duration: 1200,
      useNativeDriver: false,
    }).start();
  }, [progress]);

  const irisSize = size * 0.55;
  const fillHeight = fillAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [2, irisSize],
    extrapolate: 'clamp',
  });

  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: WHITE,
        borderWidth: 3,
        borderColor: TURQUOISE,
        justifyContent: 'center',
        alignItems: 'center',
        transform: [{ scale: pulse }],
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: irisSize,
          height: irisSize,
          borderRadius: irisSize / 2,
          backgroundColor: '#d0f0f5',
          justifyContent: 'flex-end',
          overflow: 'hidden',
        }}
      >
        <Animated.View
          style={{
            width: irisSize,
            height: fillHeight,
            backgroundColor: TURQUOISE,
          }}
        />
      </View>
    </Animated.View>
  );
}

function ArtCard({ item, s, TURQUOISE, UNSPLASH_KEY }) {
  const [imageUrl, setImageUrl] = useState(null);

  useState(() => {
    if (item.hiddenGem) return; // skip image fetch for hidden gems — Unsplash coverage is unreliable for obscure local pieces
    const query = item.imageSearch || item.name + ' ' + (item.artist || '') + ' artwork';
    fetch('https://api.unsplash.com/search/photos?query=' + encodeURIComponent(query) + '&per_page=1&orientation=landscape&client_id=' + UNSPLASH_KEY)
      .then(r => r.json())
      .then(d => { if (d.results && d.results.length > 0) setImageUrl(d.results[0].urls.regular); })
      .catch(() => {});
  }, []);

  return (
    <View style={s.card}>
      {imageUrl && <Image source={{ uri: imageUrl }} style={s.cardImage} resizeMode="contain" />}
      <Text style={s.cardTag}>{item.type || ''}</Text>
      <Text style={s.cardName}>{item.name}</Text>
      {item.artist && <Text style={s.cardMeta}>🎨 {item.artist}</Text>}
      <Text style={s.cardDesc}>{item.description}</Text>
      {item.hiddenGem && <Text style={s.badge}>💎 HIDDEN GEM</Text>}
      {item.location && <Text style={s.cardMeta}>🏛️ {item.location}</Text>}
      {item.neighbourhood && <Text style={s.cardMeta}>📍 {item.neighbourhood}</Text>}
      {item.opens && <Text style={s.cardMeta}>🕐 {item.opens}</Text>}
      {item.price && <Text style={s.cardMeta}>💰 {item.price}</Text>}
      {item.localTip && <Text style={s.highlight}>💡 {item.localTip}</Text>}
      {item.websiteSearch && (
        <TouchableOpacity onPress={() => Linking.openURL('https://www.google.com/search?q=' + encodeURIComponent(item.websiteSearch))}>
          <Text style={s.link}>🔗 Visit website</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function extractJSON(text) {
  // Strip markdown code fences first
  let cleaned = text.replace(/```json|```/g, '').trim();
  // If Claude added prose before/after the JSON, find the outermost {...} block
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

export default function App() {
  const [query, setQuery] = useState('');
  const [city, setCity] = useState('');
  const [searched, setSearched] = useState(false);
  const [activeTab, setActiveTab] = useState(null);
  const [myListVisible, setMyListVisible] = useState(false);
  const [content, setContent] = useState([]);
  const [noResultsNote, setNoResultsNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [cityImage, setCityImage] = useState(null);
  const [cityImageLoading, setCityImageLoading] = useState(false);
  const [essentialsLoading, setEssentialsLoading] = useState(false);
  const [cityTag, setCityTag] = useState('');
  const [funFact, setFunFact] = useState('');
  const [weather, setWeather] = useState(null);
  const [currency, setCurrency] = useState(null);
  const [dietaryFilter, setDietaryFilter] = useState('all');
  const [preloadedContent, setPreloadedContent] = useState({});
  const [preloadProgress, setPreloadProgress] = useState(0);
  const [preloadComplete, setPreloadComplete] = useState(false);
  const currentCityRef = useRef('');
  const [savedItems, setSavedItems] = useState([]);
  const [deviceId, setDeviceId] = useState(null);
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const [feedbackType, setFeedbackType] = useState(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);

  function openFeedback() {
    setFeedbackType(null);
    setFeedbackText('');
    setFeedbackSubmitted(false);
    setFeedbackVisible(true);
  }

  async function submitFeedback() {
    if (!feedbackText.trim() || !feedbackType) return;
    setFeedbackSubmitting(true);
    try {
      await fetch(BACKEND_URL + '/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId, city, type: feedbackType, message: feedbackText.trim() })
      });
      setFeedbackSubmitted(true);
      setFeedbackText('');
      setTimeout(() => setFeedbackVisible(false), 1500);
    } catch (e) {
      // silently fail, could add an error state here later
    }
    setFeedbackSubmitting(false);
  }

  useEffect(() => {
    async function initDevice() {
      try {
        let id = await AsyncStorage.getItem('localeDeviceId');
        if (!id) {
          id = 'device-' + Date.now() + '-' + Math.random().toString(36).substring(2, 15);
          await AsyncStorage.setItem('localeDeviceId', id);
        }
        setDeviceId(id);
        loadFavourites(id);
      } catch (e) {
        const fallbackId = 'device-' + Date.now() + '-' + Math.random().toString(36).substring(2, 15);
        setDeviceId(fallbackId);
      }
    }
    initDevice();
  }, []);

  async function loadFavourites(id) {
    try {
      const r = await fetch(BACKEND_URL + '/favourites?device_id=' + encodeURIComponent(id));
      const data = await r.json();
      if (Array.isArray(data)) setSavedItems(data);
    } catch (e) {
      // silently fail, favourites just won't load this session
    }
  }

  function isItemSaved(item) {
    return savedItems.some(s => s.item_name === item.name && s.city === city && s.category === activeTab);
  }

  async function toggleFavourite(item) {
    const alreadySaved = savedItems.find(s => s.item_name === item.name && s.city === city && s.category === activeTab);
    if (alreadySaved) {
      setSavedItems(prev => prev.filter(s => s.id !== alreadySaved.id));
      try {
        await fetch(BACKEND_URL + '/favourites/' + alreadySaved.id, { method: 'DELETE' });
      } catch (e) {}
    } else {
      const optimisticItem = { id: 'temp-' + Date.now(), device_id: deviceId, city, category: activeTab, item_name: item.name, item_data: item };
      setSavedItems(prev => [...prev, optimisticItem]);
      try {
        const r = await fetch(BACKEND_URL + '/favourites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: deviceId, city, category: activeTab, item_name: item.name, item_data: item })
        });
        const data = await r.json();
        if (Array.isArray(data) && data[0]) {
          setSavedItems(prev => prev.map(s => s.id === optimisticItem.id ? data[0] : s));
        }
      } catch (e) {}
    }
  }

  async function removeSavedItem(savedEntry) {
    setSavedItems(prev => prev.filter(s => s.id !== savedEntry.id));
    try {
      await fetch(BACKEND_URL + '/favourites/' + savedEntry.id, { method: 'DELETE' });
    } catch (e) {}
  }

  async function shareItem(item, cityName) {
    const parts = [
      item.name + ' — ' + cityName,
      item.description || '',
      item.localTip ? 'Tip: ' + item.localTip : '',
      'Found on Localé'
    ].filter(Boolean);
    try {
      await Share.share({ message: parts.join('\n\n') });
    } catch (e) {}
  }

  async function fetchSuggestions(text) {
    try {
      const r = await fetch(
        'https://maps.googleapis.com/maps/api/place/autocomplete/json?input=' + encodeURIComponent(text) + '&types=(cities)&key=' + GOOGLE_KEY
      );
      const d = await r.json();
      setSuggestions(d.predictions || []);
    } catch(e) { setSuggestions([]); }
  }

  async function fetchCityImage(cityName) {
    setCityImageLoading(true);
    setCityImage(null);
    try {
      const r = await fetch(
        'https://api.unsplash.com/search/photos?query=' + encodeURIComponent(cityName + ' city landmark skyline') + '&per_page=1&orientation=landscape&client_id=' + UNSPLASH_KEY
      );
      const d = await r.json();
      if (d.results && d.results.length > 0) setCityImage(d.results[0].urls.regular);
    } catch(e) { setCityImage(null); }
    setCityImageLoading(false);
  }

  async function fetchEssentials(cityName) {
    setEssentialsLoading(true);
    try {
      const r = await fetch(BACKEND_URL + '/recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: cityName, category: 'essentials_info' })
      });
      const d = await r.json();
      const j = extractJSON(d.content[0].text);
      setCityTag(j.cityTag || '');
      setFunFact(j.funFact || '');
      setWeather(j.weather || null);
      setCurrency(j.currency || null);
    } catch(e) { setCityTag(''); }
    setEssentialsLoading(false);
  }

  async function preloadAllTabs(cityName) {
    if (!PRELOAD_ENABLED) return;
    currentCityRef.current = cityName;
    setPreloadedContent({});
    setPreloadProgress(0);
    setPreloadComplete(false);
    await Promise.all(PRELOAD_CATEGORIES.map(async (category) => {
      try {
        const r = await fetch(BACKEND_URL + '/recommendations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ city: cityName, category })
        });
        const d = await r.json();
        const j = extractJSON(d.content[0].text);
        if (currentCityRef.current !== cityName) return; // user searched a different city since this request started
        setPreloadedContent(prev => ({
          ...prev,
          [category]: { items: j.items || [], note: j.note || '' }
        }));
        setPreloadProgress(prev => prev + 1);
      } catch (e) {
        if (currentCityRef.current === cityName) setPreloadProgress(prev => prev + 1);
        // silently skip — loadTab will fall back to a fresh fetch if this category never lands
      }
    }));
    if (currentCityRef.current === cityName) setPreloadComplete(true);
  }

  async function search() {
    if (!query.trim()) return;
    Keyboard.dismiss();
    setCity(query);
    setSearched(true);
    setActiveTab(null);
    setContent([]);
    setSuggestions([]);
    setCityImage(null);
    setCityTag('');
    setFunFact('');
    setWeather(null);
    setCurrency(null);
    setDietaryFilter('all');
    fetchCityImage(query);
    fetchEssentials(query);
    preloadAllTabs(query);
  }

  async function loadTab(key) {
    setActiveTab(key);
    setNoResultsNote('');
    setDietaryFilter('all');

    if (PRELOAD_ENABLED && preloadedContent[key]) {
      setContent(preloadedContent[key].items);
      if (preloadedContent[key].items.length === 0 && preloadedContent[key].note) {
        setNoResultsNote(preloadedContent[key].note);
      }
      setLoading(false);
      return;
    }

    setLoading(true);
    setContent([]);
    try {
      const r = await fetch(BACKEND_URL + '/recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: city, category: key })
      });
      const d = await r.json();
      const j = extractJSON(d.content[0].text);
      setContent(j.items || []);
      if ((!j.items || j.items.length === 0) && j.note) {
        setNoResultsNote(j.note);
      }
    } catch(e) { setContent([]); }
    setLoading(false);
  }

  const weatherIcon = (condition) => {
    if (!condition) return '🌤️';
    if (condition === 'sunny') return '☀️';
    if (condition === 'cloudy') return '⛅';
    if (condition === 'rainy') return '🌧️';
    if (condition === 'stormy') return '⛈️';
    return '🌤️';
  };

  const filteredContent = activeTab === 'eating' && dietaryFilter !== 'all'
    ? content.filter(item => item.dietary && item.dietary.includes(dietaryFilter))
    : content;

  if (myListVisible) {
    const groupedByCity = savedItems.reduce((acc, entry) => {
      if (!acc[entry.city]) acc[entry.city] = [];
      acc[entry.city].push(entry);
      return acc;
    }, {});
    const cities = Object.keys(groupedByCity);

    return (
      <ScrollView style={s.bg} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={() => setMyListVisible(false)} style={s.back}>
          <Text style={s.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={s.tabTitle}>❤️ My List</Text>

        {cities.length === 0 && (
          <Text style={s.empty}>Nothing saved yet — tap the heart on anything you love.</Text>
        )}

        {cities.map((cityName) => (
          <View key={cityName} style={{ marginBottom: 24 }}>
            <Text style={s.myListCityHeader}>{cityName}</Text>
            {groupedByCity[cityName].map((entry) => {
              const cat = CATEGORIES.find(c => c.key === entry.category);
              const item = entry.item_data || {};
              return (
                <View key={entry.id} style={s.card}>
                  <Text style={s.cardTag}>{cat ? cat.icon + ' ' + cat.label : entry.category}</Text>
                  <View style={s.cardNameRow}>
                    <Text style={s.cardName}>{entry.item_name}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <TouchableOpacity onPress={() => shareItem(item, cityName)} style={s.heartBtn}>
                        <Text style={s.heartIcon}>📤</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => removeSavedItem(entry)} style={s.heartBtn}>
                        <Text style={s.heartIcon}>❤️</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                  {item.description && <Text style={s.cardDesc}>{item.description}</Text>}
                  {item.localTip && <Text style={s.highlight}>💡 {item.localTip}</Text>}
                </View>
              );
            })}
          </View>
        ))}
      </ScrollView>
    );
  }

  if (activeTab) {
    const cat = CATEGORIES.find(c => c.key === activeTab);

    if (loading && cityImage) {
      return (
        <ImageBackground source={{ uri: cityImage }} style={{ flex: 1 }}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' }}>
            <Text style={{ fontSize: 36, fontWeight: '700', color: WHITE, marginBottom: 8 }}>{city}</Text>
            <Text style={{ fontSize: 20, color: 'rgba(255,255,255,0.9)', marginBottom: 40 }}>{cat.icon} {cat.label}</Text>
            <ActivityIndicator size="large" color={WHITE} />
            <Text style={{ color: 'rgba(255,255,255,0.7)', marginTop: 16, fontSize: 14 }}>Finding local knowledge...</Text>
          </View>
          <Modal visible={feedbackVisible} transparent animationType="slide" onRequestClose={() => setFeedbackVisible(false)}>
            <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
              <View style={s.modalOverlay}>
                <View style={s.modalCard}>
                {feedbackSubmitted ? (
                  <Text style={s.modalThanks}>Thanks for sharing! 🧿</Text>
                ) : !feedbackType ? (
                  <>
                    <Text style={s.modalTitle}>Share your local tip</Text>
                    <Text style={s.modalSubtitle}>{city}</Text>
                    <TouchableOpacity style={s.modalOption} onPress={() => setFeedbackType('loved')}>
                      <Text style={s.modalOptionText}>❤️ What do you love about this city?</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.modalOption} onPress={() => setFeedbackType('suggestion')}>
                      <Text style={s.modalOptionText}>💡 Secret local tip for Localé travellers</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.modalCancel} onPress={() => setFeedbackVisible(false)}>
                      <Text style={s.modalCancelText}>Cancel</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <Text style={s.modalTitle}>
                      {feedbackType === 'loved' ? '❤️ What do you love?' : '💡 Your suggestion'}
                    </Text>
                    <Text style={s.modalSubtitle}>{city}</Text>
                    <TextInput
                      style={s.modalInput}
                      multiline
                      numberOfLines={4}
                      placeholder="Type here..."
                      placeholderTextColor={GREY}
                      value={feedbackText}
                      onChangeText={setFeedbackText}
                    />
                    <TouchableOpacity
                      style={[s.modalSubmit, (!feedbackText.trim() || feedbackSubmitting) && s.modalSubmitDisabled]}
                      onPress={submitFeedback}
                      disabled={!feedbackText.trim() || feedbackSubmitting}
                    >
                      <Text style={s.modalSubmitText}>{feedbackSubmitting ? 'Sending...' : 'Submit'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.modalCancel} onPress={() => setFeedbackType(null)}>
                      <Text style={s.modalCancelText}>Back</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </View>
            </KeyboardAvoidingView>
          </Modal>
        </ImageBackground>
      );
    }

    return (
      <ScrollView style={s.bg} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={() => setActiveTab(null)} style={s.back}>
          <Text style={s.backText}>← {city}</Text>
        </TouchableOpacity>
        <Text style={s.tabTitle}>{cat.icon} {cat.label}</Text>

        {loading && <ActivityIndicator size="large" color={TURQUOISE} style={{marginTop:40}} />}
        {!loading && filteredContent.length === 0 && (
          <Text style={s.empty}>
            {noResultsNote
              ? noResultsNote
              : dietaryFilter !== 'all' ? 'No ' + dietaryFilter + ' options found' : 'No results found for ' + city}
          </Text>
        )}
        {!loading && filteredContent.map((item, i) => (
          activeTab === 'art' ? (
            <ArtCard key={i} item={item} s={s} TURQUOISE={TURQUOISE} UNSPLASH_KEY={UNSPLASH_KEY} />
          ) : (
          <View key={i} style={s.card}>
            <Text style={s.cardTag}>{item.type || item.artist || item.vibe || item.when || item.section || ''}</Text>
            <View style={s.cardNameRow}>
              <Text style={s.cardName}>{item.name}</Text>
              <TouchableOpacity onPress={() => shareItem(item, city)} style={s.heartBtn}>
                <Text style={s.heartIcon}>📤</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => toggleFavourite(item)} style={s.heartBtn}>
                <Text style={s.heartIcon}>{isItemSaved(item) ? '❤️' : '🤍'}</Text>
              </TouchableOpacity>
            </View>
            <Text style={s.cardDesc}>{item.description}</Text>
            {item.earlyBird && <Text style={s.badge}>⭐ EARLY BIRD — open before 8am</Text>}
            {item.hiddenGem && <Text style={s.badge}>💎 HIDDEN GEM</Text>}
            {item.isFree && <Text style={s.badge}>🎉 FREE</Text>}
            {item.opens && <Text style={s.cardMeta}>🕐 {item.opens}</Text>}
            {item.price && activeTab !== 'coffee' && activeTab !== 'events' && <Text style={s.cardMeta}>💰 {item.price}</Text>}
            {item.orderThis && <Text style={s.cardMeta}>🍽️ Order: {item.orderThis}</Text>}
            {item.mustOrder && <Text style={s.cardMeta}>🍽️ Must order: {item.mustOrder}</Text>}
            {item.bestTime && <Text style={s.cardMeta}>⏰ {item.bestTime}</Text>}
            {item.when && <Text style={s.cardMeta}>📅 {item.when}</Text>}
            {item.duration && <Text style={s.cardMeta}>⏱️ {item.duration}</Text>}
            {item.distance && <Text style={s.cardMeta}>📏 {item.distance}</Text>}
            {item.where && <Text style={s.cardMeta}>📍 {item.where}</Text>}
            {item.location && <Text style={s.cardMeta}>🏛️ {item.location}</Text>}
            {item.neighbourhood && <Text style={s.cardMeta}>📍 {item.neighbourhood}</Text>}
            {item.venue && <Text style={s.cardMeta}>🏟️ {item.venue}</Text>}
            {item.buyThis && <Text style={s.cardMeta}>🛍️ Buy: {item.buyThis}</Text>}
            {item.onlyHereReason && <Text style={s.highlight}>🌍 {item.onlyHereReason}</Text>}
            {item.localSecret && <Text style={s.highlight}>🔑 {item.localSecret}</Text>}
            {item.surprise && <Text style={s.highlight}>✨ {item.surprise}</Text>}
            {item.localTip && <Text style={s.highlight}>💡 {item.localTip}</Text>}
            {item.dietary && item.dietary.length > 0 && (
              <View style={s.dietaryRow}>
                {item.dietary.map((d, di) => (
                  <View key={di} style={s.dietaryTag}>
                    <Text style={s.dietaryText}>
                      {d === 'vegetarian' ? '🌱 Veg' :
                       d === 'vegan' ? '🌿 Vegan' :
                       d === 'halal' ? '☪️ Halal' :
                       d === 'kosher' ? '✡️ Kosher' :
                       d === 'pescatarian' ? '🐟 Pesc' :
                       d === 'glutenfree' ? '🌾 GF' : d}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            {item.websiteSearch && (
              <TouchableOpacity onPress={() => Linking.openURL('https://www.google.com/search?q=' + encodeURIComponent(item.websiteSearch))}>
                <Text style={s.link}>🔗 Visit website</Text>
              </TouchableOpacity>
            )}
            {item.mapSearch && (
              <TouchableOpacity onPress={() => Linking.openURL('https://maps.google.com/?q=' + encodeURIComponent(item.mapSearch))}>
                <Text style={s.link}>🗺️ View on map</Text>
              </TouchableOpacity>
            )}
            {item.bookingSearch && (
              <TouchableOpacity onPress={() => Linking.openURL('https://www.google.com/search?q=' + encodeURIComponent(item.bookingSearch + ' tickets'))}>
                <Text style={s.link}>🎟️ Get tickets</Text>
              </TouchableOpacity>
            )}
          </View>
          )
        ))}

        <TouchableOpacity style={s.tabFloatingBtn} onPress={openFeedback}>
          <Text style={s.floatingBtnText}>📍 Share your local tip</Text>
        </TouchableOpacity>

        <Modal visible={feedbackVisible} transparent animationType="slide" onRequestClose={() => setFeedbackVisible(false)}>
          <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <View style={s.modalOverlay}>
              <View style={s.modalCard}>
              {feedbackSubmitted ? (
                <Text style={s.modalThanks}>Thanks for sharing! 🧿</Text>
              ) : !feedbackType ? (
                <>
                  <Text style={s.modalTitle}>Share your local tip</Text>
                  <Text style={s.modalSubtitle}>{city}</Text>
                  <TouchableOpacity style={s.modalOption} onPress={() => setFeedbackType('loved')}>
                    <Text style={s.modalOptionText}>❤️ What do you love about this city?</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.modalOption} onPress={() => setFeedbackType('suggestion')}>
                    <Text style={s.modalOptionText}>💡 Secret local tip for Localé travellers</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.modalCancel} onPress={() => setFeedbackVisible(false)}>
                    <Text style={s.modalCancelText}>Cancel</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <Text style={s.modalTitle}>
                    {feedbackType === 'loved' ? '❤️ What do you love?' : '💡 Your suggestion'}
                  </Text>
                  <Text style={s.modalSubtitle}>{city}</Text>
                  <TextInput
                    style={s.modalInput}
                    multiline
                    numberOfLines={4}
                    placeholder="Type here..."
                    placeholderTextColor={GREY}
                    value={feedbackText}
                    onChangeText={setFeedbackText}
                  />
                  <TouchableOpacity
                    style={[s.modalSubmit, (!feedbackText.trim() || feedbackSubmitting) && s.modalSubmitDisabled]}
                    onPress={submitFeedback}
                    disabled={!feedbackText.trim() || feedbackSubmitting}
                  >
                    <Text style={s.modalSubmitText}>{feedbackSubmitting ? 'Sending...' : 'Submit'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.modalCancel} onPress={() => setFeedbackType(null)}>
                    <Text style={s.modalCancelText}>Back</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>
          </KeyboardAvoidingView>
        </Modal>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={s.bg} keyboardShouldPersistTaps="handled">
      <View style={s.hero}>
        <Text style={s.logo}>Localé</Text>
        <Text style={s.tagline}>... see the City like a Local!</Text>
      </View>

      <View>
        <View style={s.searchRow}>
          <View style={s.inputWrapper}>
            <TextInput
              style={s.input}
              placeholder="Enter a city..."
              placeholderTextColor={GREY}
              value={query}
              onChangeText={(text) => {
                setQuery(text);
                if (text.length > 2) fetchSuggestions(text);
                else setSuggestions([]);
              }}
              onSubmitEditing={search}
              returnKeyType="search"
            />
            {query.length > 0 && (
              <TouchableOpacity style={s.clearBtn} onPress={() => { setQuery(''); setSuggestions([]); setSearched(false); }}>
                <Text style={s.clearBtnText}>✕</Text>
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity style={s.btn} onPress={search}>
            <Text style={s.btnT}>Go</Text>
          </TouchableOpacity>
        </View>
        {suggestions.length > 0 && (
          <View style={s.suggestions}>
            {suggestions.map((item, i) => (
              <TouchableOpacity
                key={i}
                style={s.suggestionItem}
                onPress={() => { setQuery(item.description); setSuggestions([]); Keyboard.dismiss(); }}>
                <Text style={s.suggestionText}>📍 {item.description}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <TouchableOpacity style={s.myListBtn} onPress={() => setMyListVisible(true)}>
          <Text style={s.myListBtnText}>❤️ My List</Text>
        </TouchableOpacity>
      </View>

      {searched && (
        <View>
          {(cityImageLoading || essentialsLoading || (PRELOAD_ENABLED && !preloadComplete)) ? (
            <View style={s.cityPlaceholder}>
              <EyeLoader size={64} progress={PRELOAD_CATEGORIES.length ? preloadProgress / PRELOAD_CATEGORIES.length : 1} />
              <Text style={s.cityPlaceholderText}>Finding authentic local spots — this takes a few seconds the first time</Text>
              {funFact ? <Text style={s.funFactText}>🧿 {funFact}</Text> : null}
            </View>
          ) : cityImage ? (
            <ImageBackground
              source={{ uri: cityImage }}
              style={s.cityBg}
              imageStyle={{ borderRadius: 16 }}>
              <View style={s.cityOverlay}>
                <View style={s.cityTopRow}>
                  <View style={s.cityNameBlock}>
                    <Text style={s.cityLabelWhite}>{city}</Text>
                    {cityTag ? <Text style={s.cityTagWhite}>{cityTag}</Text> : null}
                  </View>
                  <View style={s.cityIcons}>
                    {weather && (
                      <View>
                        <Text style={s.weatherIcon}>{weatherIcon(weather.condition)}</Text>
                        <Text style={s.weatherTemp}>{weather.temp}</Text>
                      </View>
                    )}
                    {currency && (
                      <TouchableOpacity
                        style={s.currencyBtn}
                        onPress={() => Linking.openURL('https://www.xe.com/currencyconverter/convert/?Amount=1&From=USD&To=' + currency.code)}>
                        <Text style={s.currencySymbol}>{currency.symbol}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              </View>
            </ImageBackground>
          ) : (
            <View style={s.cityBgFallback}>
              <View style={s.cityTopRow}>
                <View style={s.cityNameBlock}>
                  <Text style={s.cityLabel}>{city}</Text>
                  {cityTag ? <Text style={s.cityTagDark}>{cityTag}</Text> : null}
                </View>
                <View style={s.cityIcons}>
                  {weather && (
                    <View>
                      <Text style={s.weatherIconDark}>{weatherIcon(weather.condition)}</Text>
                      <Text style={s.weatherTempDark}>{weather.temp}</Text>
                    </View>
                  )}
                  {currency && (
                    <TouchableOpacity
                      style={s.currencyBtnDark}
                      onPress={() => Linking.openURL('https://www.xe.com/currencyconverter/convert/?Amount=1&From=USD&To=' + currency.code)}>
                      <Text style={s.currencySymbolDark}>{currency.symbol}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </View>
          )}

          <View style={s.grid}>
            {CATEGORIES.map(cat => (
              <Pressable key={cat.key} style={s.catCard} onPress={() => loadTab(cat.key)}>
                <Text style={s.catIcon}>{cat.icon}</Text>
                <Text style={s.catLabel}>{cat.label}</Text>
                <Text style={s.catTeaser}>{cat.teaser}</Text>
              </Pressable>
            ))}
          </View>

          <TouchableOpacity style={s.floatingBtn} onPress={openFeedback}>
            <Text style={s.floatingBtnText}>📍 Share your local tip</Text>
          </TouchableOpacity>
        </View>
      )}

      <Modal visible={feedbackVisible} transparent animationType="slide" onRequestClose={() => setFeedbackVisible(false)}>
        <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={s.modalOverlay}>
            <View style={s.modalCard}>
            {feedbackSubmitted ? (
              <Text style={s.modalThanks}>Thanks for sharing! 🧿</Text>
            ) : !feedbackType ? (
              <>
                <Text style={s.modalTitle}>Share your local tip</Text>
                <Text style={s.modalSubtitle}>{city}</Text>
                <TouchableOpacity style={s.modalOption} onPress={() => setFeedbackType('loved')}>
                  <Text style={s.modalOptionText}>❤️ What do you love about this city?</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.modalOption} onPress={() => setFeedbackType('suggestion')}>
                  <Text style={s.modalOptionText}>💡 Secret local tip for Localé travellers</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.modalCancel} onPress={() => setFeedbackVisible(false)}>
                  <Text style={s.modalCancelText}>Cancel</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={s.modalTitle}>
                  {feedbackType === 'loved' ? '❤️ What do you love?' : '💡 Your suggestion'}
                </Text>
                <Text style={s.modalSubtitle}>{city}</Text>
                <TextInput
                  style={s.modalInput}
                  multiline
                  numberOfLines={4}
                  placeholder="Type here..."
                  placeholderTextColor={GREY}
                  value={feedbackText}
                  onChangeText={setFeedbackText}
                />
                <TouchableOpacity
                  style={[s.modalSubmit, (!feedbackText.trim() || feedbackSubmitting) && s.modalSubmitDisabled]}
                  onPress={submitFeedback}
                  disabled={!feedbackText.trim() || feedbackSubmitting}
                >
                  <Text style={s.modalSubmitText}>{feedbackSubmitting ? 'Sending...' : 'Submit'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.modalCancel} onPress={() => setFeedbackType(null)}>
                  <Text style={s.modalCancelText}>Back</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: BG, padding: 20 },
  hero: { alignItems: 'center', marginTop: 60, marginBottom: 30 },
  logo: { fontSize: 48, fontWeight: '700', color: TURQUOISE, letterSpacing: -1 },
  tagline: { fontSize: 16, color: GREY, fontStyle: 'italic', marginTop: 4 },
  searchRow: { flexDirection: 'row', gap: 10, marginBottom: 4 },
  inputWrapper: { flex: 1, position: 'relative', justifyContent: 'center' },
  input: {
    backgroundColor: WHITE, borderRadius: 12,
    padding: 14, paddingRight: 40, fontSize: 16, borderWidth: 1.5,
    borderColor: '#d0f0f5', color: DARK
  },
  clearBtn: { position: 'absolute', right: 12, padding: 4 },
  clearBtnText: { fontSize: 14, color: GREY, fontWeight: '700' },
  btn: { backgroundColor: TURQUOISE, borderRadius: 12, paddingHorizontal: 22, justifyContent: 'center' },
  btnT: { color: WHITE, fontWeight: '700', fontSize: 16 },
  suggestions: { backgroundColor: WHITE, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: '#d0f0f5', overflow: 'hidden' },
  suggestionItem: { padding: 14, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  suggestionText: { fontSize: 14, color: DARK },
  myListBtn: { alignSelf: 'center', marginTop: 12, marginBottom: 8, paddingVertical: 8, paddingHorizontal: 18, borderRadius: 20, backgroundColor: WHITE, borderWidth: 1, borderColor: '#d0f0f5' },
  myListBtnText: { fontSize: 14, color: TURQUOISE, fontWeight: '700' },
  cityPlaceholder: { width: '100%', minHeight: 140, marginBottom: 20, marginTop: 16, backgroundColor: '#d0f0f5', borderRadius: 16, justifyContent: 'center', alignItems: 'center', gap: 10, padding: 20 },
  cityPlaceholderText: { fontSize: 14, color: TURQUOISE, fontWeight: '600', textAlign: 'center' },
  funFactText: { fontSize: 13, color: DARK, fontStyle: 'italic', textAlign: 'center', marginTop: 4, paddingHorizontal: 8 },
  cityBg: { width: '100%', height: 200, marginBottom: 20, marginTop: 16 },
  cityBgFallback: { marginBottom: 20, marginTop: 16, padding: 16 },
  cityOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 16, padding: 20, justifyContent: 'flex-end' },
  cityTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  cityNameBlock: { flex: 1 },
  cityLabelWhite: { fontSize: 32, fontWeight: '700', color: WHITE },
  cityTagWhite: { fontSize: 13, color: 'rgba(255,255,255,0.9)', fontStyle: 'italic', marginTop: 2 },
  cityLabel: { fontSize: 32, fontWeight: '700', color: DARK },
  cityTagDark: { fontSize: 13, color: TURQUOISE, fontStyle: 'italic', marginTop: 2 },
  cityIcons: { alignItems: 'flex-end', gap: 8 },
  weatherIcon: { fontSize: 24, textAlign: 'center' },
  weatherTemp: { fontSize: 12, color: WHITE, textAlign: 'center', fontWeight: '600' },
  weatherIconDark: { fontSize: 24, textAlign: 'center' },
  weatherTempDark: { fontSize: 12, color: DARK, textAlign: 'center', fontWeight: '600' },
  currencyBtn: { backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 8, padding: 6, alignItems: 'center' },
  currencyBtnDark: { backgroundColor: TURQUOISE, borderRadius: 8, padding: 6, alignItems: 'center' },
  currencySymbol: { fontSize: 16, fontWeight: '700', color: WHITE },
  currencySymbolDark: { fontSize: 16, fontWeight: '700', color: WHITE },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  catCard: {
    backgroundColor: WHITE, borderRadius: 16, padding: 16, width: '47%',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08, shadowRadius: 8, elevation: 3,
    borderLeftWidth: 3, borderLeftColor: TURQUOISE,
  },
  catIcon: { fontSize: 28, marginBottom: 8 },
  catLabel: { fontSize: 15, fontWeight: '700', color: DARK, marginBottom: 4 },
  catTeaser: { fontSize: 12, color: GREY, lineHeight: 16 },
  floatingBtn: {
    backgroundColor: TURQUOISE, borderRadius: 30, paddingVertical: 14,
    paddingHorizontal: 24, alignItems: 'center', marginTop: 24, marginBottom: 40,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15, shadowRadius: 8, elevation: 6,
  },
  floatingBtnText: { color: WHITE, fontWeight: '700', fontSize: 15 },
  back: { marginBottom: 20, marginTop: 8, padding: 12, backgroundColor: WHITE, borderRadius: 10, borderWidth: 1, borderColor: '#d0f0f5' },
  backText: { color: TURQUOISE, fontSize: 16, fontWeight: '700' },
  tabTitle: { fontSize: 26, fontWeight: '700', color: DARK, marginBottom: 16 },
  myListCityHeader: { fontSize: 18, fontWeight: '700', color: TURQUOISE, marginBottom: 10, textTransform: 'capitalize' },
  filterRow: { marginBottom: 16 },
  filterBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: WHITE, borderWidth: 1, borderColor: '#d0f0f5', marginRight: 8 },
  filterBtnActive: { backgroundColor: TURQUOISE, borderColor: TURQUOISE },
  filterText: { fontSize: 13, color: GREY, fontWeight: '500' },
  filterTextActive: { color: WHITE },
  card: {
    backgroundColor: WHITE, borderRadius: 14, padding: 16,
    marginBottom: 12, borderLeftWidth: 3, borderLeftColor: TURQUOISE,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 6, elevation: 2,
  },
  cardImage: { width: '100%', height: 180, borderRadius: 10, marginBottom: 12, backgroundColor: '#f0f0f0' },
  cardNameRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  heartBtn: { padding: 4 },
  heartIcon: { fontSize: 20 },
  cardTag: { fontSize: 11, color: TURQUOISE, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 },
  cardName: { fontSize: 18, fontWeight: '700', color: DARK, marginBottom: 6, flex: 1, paddingRight: 8 },
  cardDesc: { fontSize: 14, color: '#555', lineHeight: 20 },
  cardMeta: { fontSize: 12, color: GREY, marginTop: 6 },
  badge: { fontSize: 11, color: '#ff9800', fontWeight: '700', marginTop: 6 },
  highlight: { fontSize: 13, color: '#9c27b0', marginTop: 6, fontStyle: 'italic' },
  link: { fontSize: 13, color: TURQUOISE, marginTop: 8, textDecorationLine: 'underline' },
  dietaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  dietaryTag: { backgroundColor: '#f0fffe', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: '#d0f0f5' },
  dietaryText: { fontSize: 11, color: DARK },
  tabFloatingBtn: {
    backgroundColor: TURQUOISE, borderRadius: 30, paddingVertical: 14,
    paddingHorizontal: 24, alignItems: 'center', marginTop: 16, marginBottom: 40,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15, shadowRadius: 8, elevation: 6,
  },
  empty: { fontSize: 14, color: GREY, textAlign: 'center', marginTop: 40 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: WHITE, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
  modalTitle: { fontSize: 20, fontWeight: '700', color: DARK, textAlign: 'center', marginBottom: 4 },
  modalSubtitle: { fontSize: 14, color: TURQUOISE, fontWeight: '600', textAlign: 'center', marginBottom: 20 },
  modalOption: {
    backgroundColor: BG, borderRadius: 14, padding: 18, marginBottom: 12,
    borderWidth: 1, borderColor: '#d0f0f5',
  },
  modalOptionText: { fontSize: 15, color: DARK, fontWeight: '600' },
  modalInput: {
    backgroundColor: BG, borderRadius: 12, padding: 14, fontSize: 15, color: DARK,
    minHeight: 100, textAlignVertical: 'top', borderWidth: 1, borderColor: '#d0f0f5', marginBottom: 16,
  },
  modalSubmit: {
    backgroundColor: TURQUOISE, borderRadius: 30, paddingVertical: 14,
    alignItems: 'center', marginBottom: 8,
  },
  modalSubmitDisabled: { opacity: 0.4 },
  modalSubmitText: { color: WHITE, fontSize: 15, fontWeight: '700' },
  modalCancel: { paddingVertical: 10, alignItems: 'center' },
  modalCancelText: { color: GREY, fontSize: 14 },
  modalThanks: { fontSize: 20, fontWeight: '700', color: TURQUOISE, textAlign: 'center', paddingVertical: 30 },
});
