/**
 * Dynamic Environmental Achievement NFTs
 * Quick implementation leveraging existing gamification and NFT infrastructure
 */

const express = require('express');
const router = express.Router();
const { nftLogger } = require('../server/utils/logger');

// Achievement NFT templates with rarity levels
const achievementTemplates = {
  carbon_neutral: {
    name: 'Carbon Neutral Champion',
    description: 'Achieved carbon neutrality for 12 consecutive months',
    category: 'carbon_reduction',
    rarity: 'legendary',
    base_image: '/nft/templates/carbon-neutral.svg',
    requirements: { months_carbon_neutral: 12 },
    attributes: {
      co2_reduced: 0, // Will be calculated dynamically
      verification_method: 'blockchain_verified',
      achievement_date: null,
    },
  },

  weather_warrior: {
    name: 'Weather Data Warrior',
    description:
      'Contributed high-quality weather data for environmental science',
    category: 'data_contribution',
    rarity: 'epic',
    base_image: '/nft/templates/weather-warrior.svg',
    requirements: { data_points_contributed: 1000, quality_score: 0.95 },
    attributes: {
      data_points: 0,
      quality_score: 0,
      stations_contributed: 0,
    },
  },

  renewable_pioneer: {
    name: 'Renewable Energy Pioneer',
    description: 'Transitioned to 100% renewable energy sources',
    category: 'energy_transition',
    rarity: 'epic',
    base_image: '/nft/templates/renewable-pioneer.svg',
    requirements: { renewable_percentage: 100, verification_period: 6 },
    attributes: {
      renewable_percentage: 0,
      energy_source: '',
      kwh_green: 0,
    },
  },

  eco_educator: {
    name: 'Eco Educator',
    description: 'Educated others about environmental sustainability',
    category: 'education',
    rarity: 'rare',
    base_image: '/nft/templates/eco-educator.svg',
    requirements: { people_educated: 50, education_sessions: 10 },
    attributes: {
      people_reached: 0,
      sessions_completed: 0,
      impact_score: 0,
    },
  },

  zero_waste: {
    name: 'Zero Waste Hero',
    description: 'Achieved zero waste lifestyle for sustained period',
    category: 'waste_reduction',
    rarity: 'epic',
    base_image: '/nft/templates/zero-waste.svg',
    requirements: { waste_reduction_percentage: 95, months_sustained: 6 },
    attributes: {
      waste_reduced_kg: 0,
      recycling_rate: 0,
      composting_rate: 0,
    },
  },
};

// Rarity system with evolution mechanics
const raritySystem = {
  common: { color: '#95a5a6', glow: false, particles: false },
  rare: { color: '#3498db', glow: true, particles: false },
  epic: { color: '#9b59b6', glow: true, particles: true },
  legendary: { color: '#f1c40f', glow: true, particles: true, animated: true },
};

// Generate dynamic NFT metadata based on user achievements
const generateNFTMetadata = (achievementType, userStats) => {
  const template = achievementTemplates[achievementType];
  if (!template) return null;

  const rarity = raritySystem[template.rarity];
  const currentDate = new Date().toISOString();

  // Calculate dynamic attributes based on user performance
  const dynamicAttributes = { ...template.attributes };

  switch (achievementType) {
    case 'carbon_neutral':
      dynamicAttributes.co2_reduced = userStats.carbonReduced || 0;
      dynamicAttributes.achievement_date = currentDate;
      break;

    case 'weather_warrior':
      dynamicAttributes.data_points = userStats.dataPointsContributed || 0;
      dynamicAttributes.quality_score = userStats.qualityScore || 0;
      dynamicAttributes.stations_contributed =
        userStats.stationsContributed || 0;
      break;

    case 'renewable_pioneer':
      dynamicAttributes.renewable_percentage =
        userStats.renewablePercentage || 0;
      dynamicAttributes.energy_source = userStats.energySource || 'mixed';
      dynamicAttributes.kwh_green = userStats.kwhGreen || 0;
      break;
  }

  return {
    name: template.name,
    description: template.description,
    image: generateDynamicImage(template.base_image, rarity, dynamicAttributes),
    category: template.category,
    rarity: template.rarity,
    attributes: [
      { trait_type: 'Rarity', value: template.rarity },
      { trait_type: 'Category', value: template.category },
      { trait_type: 'Achievement Date', value: currentDate },
      ...Object.entries(dynamicAttributes).map(([key, value]) => ({
        trait_type: key
          .replace(/_/g, ' ')
          .replace(/\b\w/g, l => l.toUpperCase()),
        value: value,
      })),
    ],
    properties: {
      created_at: currentDate,
      evolution_stage: calculateEvolutionStage(
        userStats,
        template.requirements
      ),
      next_evolution: getNextEvolutionRequirements(
        userStats,
        template.requirements
      ),
    },
  };
};

// Generate dynamic visual properties for NFT
const generateDynamicImage = (baseImage, rarity, attributes) => {
  return {
    base: baseImage,
    visual_effects: {
      color_scheme: rarity.color,
      glow_effect: rarity.glow,
      particle_effects: rarity.particles,
      animation: rarity.animated || false,
    },
    dynamic_elements: {
      progress_bar: calculateProgressVisualization(attributes),
      achievement_badge: rarity.color,
      background_pattern: `pattern_${Math.floor(Math.random() * 5) + 1}`,
    },
  };
};

// Calculate evolution stage based on performance
const calculateEvolutionStage = (userStats, requirements) => {
  const stages = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
  const completionRatio = calculateCompletionRatio(userStats, requirements);

  if (completionRatio >= 5.0) return 'diamond';
  if (completionRatio >= 3.0) return 'platinum';
  if (completionRatio >= 2.0) return 'gold';
  if (completionRatio >= 1.5) return 'silver';
  return 'bronze';
};

const calculateCompletionRatio = (userStats, requirements) => {
  let totalRatio = 0;
  let criteriaCount = 0;

  Object.entries(requirements).forEach(([key, required]) => {
    const userValue = userStats[key] || 0;
    totalRatio += userValue / required;
    criteriaCount++;
  });

  return criteriaCount > 0 ? totalRatio / criteriaCount : 0;
};

const calculateProgressVisualization = attributes => {
  return {
    primary_metric: Object.values(attributes)[0] || 0,
    progress_color: '#2ecc71',
    completion_percentage: Math.min(
      100,
      (Object.values(attributes)[0] || 0) * 10
    ),
  };
};

// API Endpoints

// Get available achievement NFTs for user
router.get('/available/:userAddress', async (req, res) => {
  try {
    const { userAddress } = req.params;

    // Input validation
    if (typeof userAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      return res.status(400).json({
        success: false,
        error: 'userAddress must be a valid Ethereum address',
      });
    }

    // Mock user statistics (replace with actual database queries)
    const userStats = {
      carbonReduced: 2500, // kg CO2
      dataPointsContributed: 1200,
      qualityScore: 0.97,
      stationsContributed: 3,
      renewablePercentage: 85,
      energySource: 'solar',
      kwhGreen: 2400,
      people_educated: 45,
      education_sessions: 8,
      waste_reduction_percentage: 78,
      months_sustained: 4,
    };

    const availableAchievements = [];
    const eligibleAchievements = [];

    Object.entries(achievementTemplates).forEach(([key, template]) => {
      const isEligible = checkEligibility(userStats, template.requirements);
      const completionRatio = calculateCompletionRatio(
        userStats,
        template.requirements
      );

      const achievementData = {
        id: key,
        template,
        eligible: isEligible,
        completion_percentage: Math.min(100, completionRatio * 100),
        requirements_status: Object.entries(template.requirements).map(
          ([req, needed]) => ({
            requirement: req,
            needed,
            current: userStats[req] || 0,
            met: (userStats[req] || 0) >= needed,
          })
        ),
      };

      if (isEligible) {
        eligibleAchievements.push(achievementData);
      } else {
        availableAchievements.push(achievementData);
      }
    });

    res.json({
      success: true,
      userAddress,
      eligible_achievements: eligibleAchievements,
      available_achievements: availableAchievements,
      total_achievements: Object.keys(achievementTemplates).length,
    });
  } catch (error) {
    nftLogger.error('Error fetching available achievements', { api: 'environmental-achievement-nfts', error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch available achievements',
    });
  }
});

// Mint achievement NFT
router.post('/mint', async (req, res) => {
  try {
    const { userAddress, achievementType, userStats } = req.body;

    // Input validation
    if (typeof userAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      return res.status(400).json({
        success: false,
        error: 'userAddress must be a valid Ethereum address',
      });
    }
    if (typeof achievementType !== 'string' || achievementType.length === 0 || achievementType.length > 100) {
      return res.status(400).json({
        success: false,
        error: 'achievementType must be a non-empty string under 100 chars',
      });
    }
    if (userStats !== undefined && (typeof userStats !== 'object' || userStats === null || Array.isArray(userStats))) {
      return res.status(400).json({
        success: false,
        error: 'userStats must be an object',
      });
    }
    // Validate numeric fields in userStats if present
    if (userStats) {
      const numericFields = ['carbonReduced', 'dataPointsContributed', 'qualityScore', 'stationsContributed', 'renewablePercentage', 'kwhGreen', 'people_educated', 'education_sessions', 'waste_reduction_percentage', 'months_sustained'];
      for (const field of numericFields) {
        if (userStats[field] !== undefined && (typeof userStats[field] !== 'number' || userStats[field] < 0)) {
          return res.status(400).json({
            success: false,
            error: `userStats.${field} must be a non-negative number`,
          });
        }
      }
    }

    const template = achievementTemplates[achievementType];
    if (!template) {
      return res.status(400).json({
        success: false,
        error: 'Invalid achievement type',
      });
    }

    // Check eligibility
    const isEligible = checkEligibility(userStats, template.requirements);
    if (!isEligible) {
      return res.status(400).json({
        success: false,
        error: 'User not eligible for this achievement',
        requirements: template.requirements,
        current_stats: userStats,
      });
    }

    // Generate NFT metadata
    const metadata = generateNFTMetadata(achievementType, userStats);

    // Simulate NFT minting (replace with actual blockchain interaction)
    const nftId = `env_${achievementType}_${Date.now()}`;

    res.json({
      success: true,
      nft: {
        id: nftId,
        owner: userAddress,
        metadata,
        minted_at: new Date().toISOString(),
        blockchain_tx: `0x${Math.random().toString(16).substr(2, 64)}`, // Mock transaction hash
        ipfs_hash: `Qm${Math.random().toString(36).substr(2, 44)}`, // Mock IPFS hash
      },
      message: 'Environmental Achievement NFT minted successfully!',
    });
  } catch (error) {
    nftLogger.error('Error minting achievement NFT', { api: 'environmental-achievement-nfts', error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to mint achievement NFT',
    });
  }
});

// Get user's achievement NFT collection
router.get('/collection/:userAddress', async (req, res) => {
  try {
    const { userAddress } = req.params;

    // Input validation
    if (typeof userAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      return res.status(400).json({
        success: false,
        error: 'userAddress must be a valid Ethereum address',
      });
    }

    // Mock collection data (replace with blockchain queries)
    const collection = [
      {
        id: 'env_weather_warrior_1234567',
        achievement_type: 'weather_warrior',
        metadata: generateNFTMetadata('weather_warrior', {
          dataPointsContributed: 1200,
          qualityScore: 0.97,
          stationsContributed: 3,
        }),
        minted_at: '2025-06-15T10:30:00Z',
        current_value: '0.05 ETH',
      },
      {
        id: 'env_eco_educator_1234568',
        achievement_type: 'eco_educator',
        metadata: generateNFTMetadata('eco_educator', {
          people_educated: 52,
          education_sessions: 12,
        }),
        minted_at: '2025-06-10T14:20:00Z',
        current_value: '0.03 ETH',
      },
    ];

    res.json({
      success: true,
      userAddress,
      collection,
      collection_stats: {
        total_nfts: collection.length,
        rarity_breakdown: {
          legendary: collection.filter(
            nft => nft.metadata.rarity === 'legendary'
          ).length,
          epic: collection.filter(nft => nft.metadata.rarity === 'epic').length,
          rare: collection.filter(nft => nft.metadata.rarity === 'rare').length,
          common: collection.filter(nft => nft.metadata.rarity === 'common')
            .length,
        },
        total_estimated_value: '0.08 ETH',
      },
    });
  } catch (error) {
    nftLogger.error('Error fetching NFT collection', { api: 'environmental-achievement-nfts', error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch NFT collection',
    });
  }
});

// Helper function to check eligibility
const checkEligibility = (userStats, requirements) => {
  return Object.entries(requirements).every(([key, required]) => {
    return (userStats[key] || 0) >= required;
  });
};

const getNextEvolutionRequirements = (userStats, currentRequirements) => {
  const evolutionMultiplier = 1.5;
  return Object.entries(currentRequirements).reduce((acc, [key, value]) => {
    acc[key] = Math.floor(value * evolutionMultiplier);
    return acc;
  }, {});
};

module.exports = router;
